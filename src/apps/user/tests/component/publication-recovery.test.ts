import { expect, test } from 'bun:test';
import { connect, type Channel, type GetMessage } from 'amqplib';
import { z } from 'zod';
import { withCleanup } from '../../../../../scripts/tests/cleanup';
import { brokerGate } from '../../../../../scripts/tests/broker-gate';
import {
  getHttpServer,
  ownerDatabase,
  startUser,
  stopUser,
  userOutput,
} from './user-process';

const options = {
  hostname: process.env.RABBITMQ_HOST,
  port: Number(process.env.RABBITMQ_PORT),
  username: process.env.RABBITMQ_USERNAME,
  password: process.env.RABBITMQ_PASSWORD,
  vhost: process.env.RABBITMQ_VHOST,
};
const profile = {
  email: 'recovery@example.com',
  country: 'England',
  street: 'Baker street',
  postalCode: 'NW16XE',
};

async function until(
  condition: () => boolean | Promise<boolean>,
): Promise<void> {
  const deadline = Date.now() + 12_000;
  while (!(await condition())) {
    if (Date.now() > deadline)
      throw new Error(`Publication did not recover: ${userOutput()}`);
    await Bun.sleep(25);
  }
}

function publicationFailures(): Record<string, unknown>[] {
  return userOutput()
    .split('\n')
    .slice(0, -1)
    .filter((line) => line.trim())
    .map((line) => z.record(z.string(), z.unknown()).parse(JSON.parse(line)))
    .filter((record) => record.operation === 'outbox.failed');
}

async function withBroker(
  use: (channel: Channel) => Promise<void>,
): Promise<void> {
  const connection = await connect(options, { timeout: 2_000 });
  await withCleanup(async () => {
    const channel = await connection.createChannel();
    await channel.assertExchange('user.events', 'direct', { durable: true });
    await channel.assertQueue('wallet.user-created', { durable: true });
    await channel.bindQueue(
      'wallet.user-created',
      'user.events',
      'user.created.v1',
    );
    await channel.purgeQueue('wallet.user-created');
    await use(channel);
  }, [() => withCleanup(stopUser, [() => connection.close()])]);
}

async function pending(): Promise<boolean> {
  return (
    (
      await ownerDatabase().query(
        'SELECT * FROM user_outbox WHERE published_at IS NULL',
      )
    ).rowCount === 1
  );
}

async function startConnected(port = String(options.port)): Promise<void> {
  await stopUser();
  await startUser({ RABBITMQ_PORT: port });
  await until(() => userOutput().includes('User publisher connected.'));
}

async function take(channel: Channel): Promise<GetMessage> {
  const message = await channel.get('wallet.user-created', { noAck: true });
  if (!message) throw new Error('Missing routed message');
  return message;
}

async function proveRecovery(
  channel: Channel,
  original?: GetMessage,
): Promise<void> {
  await startConnected();
  await until(async () => !(await pending()));
  const message = await take(channel);
  const row = z
    .object({ event_id: z.string(), envelope: z.unknown() })
    .parse(
      (
        await ownerDatabase().query(
          'SELECT event_id, envelope FROM user_outbox',
        )
      ).rows[0],
    );
  expect(message.properties.messageId).toBe(row.event_id);
  expect(JSON.parse(message.content.toString()) as unknown).toEqual(
    row.envelope,
  );
  if (original) {
    expect(message.content).toEqual(original.content);
    expect(message.properties.messageId).toBe(original.properties.messageId);
  }
}

test.each(['connection', 'selection'] as const)(
  'each %s failure before selecting an event emits one complete publication warning',
  async (failure) => {
    await stopUser();
    if (failure === 'selection')
      await ownerDatabase().query(
        'REVOKE SELECT ON user_outbox FROM user_runtime',
      );
    await withCleanup(async () => {
      if (failure === 'selection') await startConnected();
      else await startUser();
      await until(() =>
        publicationFailures().some((record) => record.retryDelayMs === 500),
      );
      await stopUser();
      const failures = publicationFailures();
      for (const retryDelayMs of [250, 500])
        expect(
          failures.filter((record) => record.retryDelayMs === retryDelayMs),
        ).toHaveLength(1);
      for (const record of failures) {
        expect(record).toMatchObject({ level: 'warn', service: 'user' });
        expect(record.message).toEqual(
          expect.stringContaining('User publication uncertain'),
        );
        expect(record.error).toHaveProperty('message');
        expect(record).not.toHaveProperty('eventId');
        expect(record).not.toHaveProperty('correlationId');
      }
    }, [
      stopUser,
      async () => {
        if (failure === 'selection')
          await ownerDatabase().query(
            'GRANT SELECT ON user_outbox TO user_runtime',
          );
      },
    ]);
  },
  30_000,
);

test('a mandatory routing return leaves committed work pending even when the broker confirms', async () => {
  await withBroker(async (channel) => {
    await startConnected();
    await channel.unbindQueue(
      'wallet.user-created',
      'user.events',
      'user.created.v1',
    );
    await getHttpServer().post('/v1/users').send(profile).expect(201);
    await until(() => userOutput().includes('publication uncertain'));
    await stopUser();
    expect(await pending()).toBe(true);
    expect((await channel.checkQueue('wallet.user-created')).messageCount).toBe(
      0,
    );
    await proveRecovery(channel);
  });
}, 30_000);

test.each(['timeout', 'shutdown'] as const)(
  'a missing confirmation remains recoverable after %s with the persisted identity',
  async (interruption) => {
    await withBroker(async (channel) => {
      const gate = await brokerGate({
        hostname: String(options.hostname),
        port: options.port,
      });
      gate.allow();
      gate.withholdConfirmations();
      await withCleanup(async () => {
        await startConnected(gate.port);
        await getHttpServer().post('/v1/users').send(profile).expect(201);
        await until(() => gate.confirmations() > 0);
        expect(await pending()).toBe(true);
        const original = await take(channel);
        if (interruption === 'timeout')
          await until(() => userOutput().includes('publication uncertain'));
        await stopUser();
        expect(await pending()).toBe(true);
        expect(gate.attempts()).toBeLessThanOrEqual(2);
        await proveRecovery(channel, original);
      }, [() => withCleanup(stopUser, [() => gate.close()])]);
    });
  },
  30_000,
);

test('broker success followed by a failed completion write retains work and permits duplicate delivery', async () => {
  await withBroker(async (channel) => {
    await ownerDatabase().query(
      `CREATE FUNCTION fail_publication() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Completion write failed'; END $$; CREATE TRIGGER fail_publication BEFORE UPDATE ON user_outbox FOR EACH ROW EXECUTE FUNCTION fail_publication();`,
    );
    let original: GetMessage | undefined;
    await withCleanup(async () => {
      await startConnected();
      await getHttpServer().post('/v1/users').send(profile).expect(201);
      await until(() => userOutput().includes('publication uncertain'));
      await stopUser();
      expect(await pending()).toBe(true);
      original = await take(channel);
      const failures = publicationFailures();
      expect(failures.length).toBeGreaterThan(0);
      for (const record of failures)
        expect(record).toMatchObject({
          message: expect.stringContaining(
            'User publication uncertain',
          ) as unknown,
          eventId: original.properties.messageId as unknown,
          correlationId: original.properties.correlationId as unknown,
        });
    }, [
      () =>
        ownerDatabase().query(
          'DROP TRIGGER fail_publication ON user_outbox; DROP FUNCTION fail_publication()',
        ),
    ]);
    await proveRecovery(channel, original);
  });
}, 30_000);

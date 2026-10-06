import { expect, test } from 'bun:test';
import { connect } from 'amqplib';
import { z } from 'zod';
import {
  getHttpServer,
  ownerDatabase,
  startUser,
  stopUser,
  userOutput,
} from './user-process';
import {
  brokerOptions,
  receive,
  send,
  until,
  withCommands,
} from './command-fixture';
import { withCleanup } from '../../../../../scripts/tests/cleanup';
import { brokerGate } from '../../../../../scripts/tests/broker-gate';
import baseline from '../unit/fixtures/user-create-v1.json';

test('user.create commits a profile and correlated outbox event before returning its identity without Wallet', async () => {
  await withCommands(async (channel, replies) => {
    await send(channel, replies, baseline);
    const message = await receive(channel, replies);
    const response = z
      .object({ result: z.object({ id: z.uuid() }) })
      .parse(JSON.parse(message.content.toString()));
    expect(JSON.parse(message.content.toString()) as unknown).toEqual({
      type: 'user.create.result',
      version: 1,
      commandId: 'create-profile-001',
      correlationId: 'signup-001',
      result: { id: response.result.id },
    });
    expect(message.properties.correlationId).toBe('signup-001');
    expect(
      (await getHttpServer().get('/v1/users').expect(200)).body,
    ).toMatchObject({
      count: 1,
      data: [{ id: response.result.id, email: 'command@example.com' }],
    });
    const events = await ownerDatabase().query(
      'SELECT envelope FROM user_outbox',
    );
    expect(events.rows).toHaveLength(1);
    expect(events.rows).toMatchObject([
      {
        envelope: {
          type: 'user.created',
          correlationId: 'signup-001',
          causationId: 'create-profile-001',
          data: { userId: response.result.id },
        },
      },
    ]);
    await send(channel, replies, baseline);
    expect(
      JSON.parse(
        (await receive(channel, replies)).content.toString(),
      ) as unknown,
    ).toMatchObject({
      error: { code: 'USER.ALREADY_EXISTS', message: 'User already exists' },
    });
    expect((await ownerDatabase().query('SELECT * FROM users')).rowCount).toBe(
      1,
    );
    expect(
      (await ownerDatabase().query('SELECT * FROM user_outbox')).rowCount,
    ).toBe(1);
  });
}, 25_000);

test('invalid payloads, unsupported commands and missing reply metadata are retained without business mutations', async () => {
  await withCommands(async (channel, replies) => {
    const bodies = [
      Buffer.from('{'),
      Buffer.from([0xff]),
      Buffer.from(JSON.stringify({ ...baseline, version: 2 })),
      Buffer.from(JSON.stringify({ ...baseline, type: 'user.created' })),
      Buffer.from(
        JSON.stringify({
          ...baseline,
          data: { ...baseline.data, email: 'invalid' },
        }),
      ),
      Buffer.from(JSON.stringify(baseline)),
    ];
    for (const [index, body] of bodies.entries()) {
      channel.publish('user.commands', 'user.create', body, {
        persistent: true,
        mandatory: true,
        expiration: '60000',
        messageId: 'create-profile-001',
        correlationId: 'signup-001',
        replyTo: index === bodies.length - 1 ? undefined : replies,
        headers: { 'producer-note': 'preserved' },
      });
      await channel.waitForConfirms();
      const retained = await receive(channel, 'user.create.failed');
      expect(retained.content).toEqual(body);
      expect(retained.properties).toMatchObject({
        messageId: 'create-profile-001',
        correlationId: 'signup-001',
        deliveryMode: 2,
        headers: {
          'producer-note': 'preserved',
          'user-command-failure-reason':
            index === bodies.length - 1
              ? 'invalid-command-properties'
              : 'invalid-or-unsupported-user-create',
        },
      });
      expect(retained.properties.expiration).toBeUndefined();
    }
    expect((await ownerDatabase().query('SELECT * FROM users')).rows).toEqual(
      [],
    );
    expect(
      (await ownerDatabase().query('SELECT * FROM user_outbox')).rows,
    ).toEqual([]);
    expect(await channel.get(replies, { noAck: true })).toBe(false);
  });
}, 25_000);

test('outbox failure rolls back User and leaves the command unacknowledged for recovery', async () => {
  await withCommands(async (channel, replies) => {
    const owner = ownerDatabase();
    await owner.query('REVOKE INSERT ON user_outbox FROM user_runtime');
    await withCleanup(async () => {
      await send(channel, replies, baseline);
      await until(() => userOutput().includes('User command delivery failed;'));
      await stopUser();
      expect((await owner.query('SELECT * FROM users')).rows).toEqual([]);
      expect((await owner.query('SELECT * FROM user_outbox')).rows).toEqual([]);
      expect(await channel.get(replies, { noAck: true })).toBe(false);
      const pending = await channel.get('user.create', { noAck: false });
      if (!pending)
        throw new Error('Command was acknowledged before local commit');
      expect(pending.content.toString()).toBe(JSON.stringify(baseline));
      expect(pending.fields.redelivered).toBe(true);
      channel.nack(pending, false, true);
    }, [() => owner.query('GRANT INSERT ON user_outbox TO user_runtime')]);
    await startUser({ RABBITMQ_PORT: String(brokerOptions.port) });
    expect(
      JSON.parse(
        (await receive(channel, replies)).content.toString(),
      ) as unknown,
    ).toHaveProperty('result.id');
    expect((await owner.query('SELECT * FROM users')).rowCount).toBe(1);
    expect((await owner.query('SELECT * FROM user_outbox')).rowCount).toBe(1);
  });
}, 25_000);

test('consumer reconnects after unavailable startup and disconnect while HTTP and GraphQL remain usable', async () => {
  await withCommands(async (channel, replies) => {
    const expectCreatedReply = async (
      phase: string,
      queue: string,
    ): Promise<void> => {
      const reply = await receive(channel, queue);
      const body = reply.content.toString();
      const diagnostic = JSON.stringify({
        phase,
        correlationId: reply.properties.correlationId as unknown,
        messageId: reply.properties.messageId as unknown,
        redelivered: reply.fields.redelivered,
        response: body,
      });
      expect(
        JSON.parse(body) as unknown,
        `Command reply: ${diagnostic}\nUser output:\n${userOutput()}`,
      ).toHaveProperty('result.id');
    };
    await stopUser();
    const gate = await brokerGate({
      hostname: String(brokerOptions.hostname),
      port: brokerOptions.port,
    });
    await withCleanup(async () => {
      await startUser({ RABBITMQ_PORT: gate.port });
      await send(channel, replies, baseline);
      await getHttpServer().get('/v1/users').expect(200);
      expect(
        (
          await getHttpServer()
            .post('/graphql')
            .send({
              query: '{ findUsers(options: "") { count } }',
            })
            .expect(200)
        ).body,
      ).toMatchObject({ data: { findUsers: { count: 0 } } });
      await until(() => userOutput().includes('User commands reconnect in'));
      expect(await channel.get(replies, { noAck: true })).toBe(false);
      gate.allow();
      await expectCreatedReply('startup recovery', replies);
      // A reply can arrive before the command ACK; leave a duplicate response
      // pending so the next phase cannot accidentally consume the earlier reply.
      await send(channel, replies, baseline);
      await until(() =>
        userOutput().includes('User command rejected by business rules.'),
      );
      const { queue: reconnectReplies } = await channel.assertQueue('', {
        exclusive: true,
      });
      gate.block();
      await getHttpServer().get('/v1/users').expect(200);
      await send(channel, reconnectReplies, {
        ...baseline,
        data: { ...baseline.data, email: 'reconnected@example.com' },
      });
      gate.allow();
      await expectCreatedReply('disconnect recovery', reconnectReplies);
      expect(
        (await ownerDatabase().query('SELECT * FROM users')).rowCount,
      ).toBe(2);
    }, [() => withCleanup(stopUser, [() => gate.close()])]);
  });
}, 35_000);

test('publisher and APIs continue while command topology fails; consumer recovers after repair and cancellation', async () => {
  await withCommands(async (channel, replies) => {
    await stopUser();
    await channel.deleteExchange('user.commands');
    await channel.assertExchange('user.commands', 'fanout', { durable: true });
    await startUser({ RABBITMQ_PORT: String(brokerOptions.port) });
    await until(() => userOutput().includes('User commands reconnect in'));
    await channel.assertQueue('wallet.user-created', { durable: true });
    await channel.purgeQueue('wallet.user-created');
    await getHttpServer()
      .post('/v1/users')
      .send({ ...baseline.data, email: 'http-independent@example.com' })
      .expect(201);
    expect(
      JSON.parse(
        (await receive(channel, 'wallet.user-created')).content.toString(),
      ) as unknown,
    ).toHaveProperty('type', 'user.created');
    await channel.deleteExchange('user.commands');
    await until(() =>
      userOutput().includes('User command consumer connected.'),
    );
    await send(channel, replies, baseline);
    expect(
      JSON.parse(
        (await receive(channel, replies)).content.toString(),
      ) as unknown,
    ).toHaveProperty('result.id');
    await channel.deleteQueue('user.create');
    await until(
      () => userOutput().split('User command consumer connected.').length >= 3,
    );
    await send(channel, replies, {
      ...baseline,
      data: { ...baseline.data, email: 'after-cancellation@example.com' },
    });
    expect(
      JSON.parse(
        (await receive(channel, replies)).content.toString(),
      ) as unknown,
    ).toHaveProperty('result.id');
  });
}, 30_000);

test.each(['open', 'closed'] as const)(
  'a failed topology scenario preserves its error and leaves the next command usable (channel %s)',
  async (channelState) => {
    const failure = new Error(
      'Injected failure after command topology mutation',
    );
    const connection = await connect(brokerOptions, { timeout: 2_000 });
    await withCleanup(async () => {
      const outcome = await withCommands(async (channel) => {
        await stopUser();
        await channel.deleteExchange('user.commands');
        await channel.assertExchange('user.commands', 'fanout', {
          durable: true,
        });
        if (channelState === 'closed') await channel.close();
        throw failure;
      }).catch((error: unknown) => error);
      expect(outcome).toBe(failure);

      const probe = await connection.createChannel();
      probe.on('error', () => undefined);
      await probe.assertExchange('user.commands', 'direct', { durable: true });
      await withCommands(async (channel, replies) => {
        await send(channel, replies, baseline);
        expect(
          JSON.parse(
            (await receive(channel, replies)).content.toString(),
          ) as unknown,
        ).toHaveProperty('result.id');
      });
    }, [
      () =>
        withCleanup(
          () =>
            withCleanup(stopUser, [
              async () => {
                const restore = await connection.createChannel();
                await restore.deleteExchange('user.commands');
                await restore.assertExchange('user.commands', 'direct', {
                  durable: true,
                });
              },
            ]),
          [() => connection.close()],
        ),
    ]);
  },
  25_000,
);

test('an unroutable failure copy is retried instead of discarding the invalid command', async () => {
  await withCommands(async (channel, replies) => {
    await until(() =>
      userOutput().includes('User command consumer connected.'),
    );
    await channel.deleteQueue('user.create.failed');
    const invalid = { ...baseline, version: 99 };
    await send(channel, replies, invalid);
    await until(
      () => userOutput().split('User command consumer connected.').length >= 3,
    );
    expect(
      (await receive(channel, 'user.create.failed')).content.toString(),
    ).toBe(JSON.stringify(invalid));
    expect((await ownerDatabase().query('SELECT * FROM users')).rowCount).toBe(
      0,
    );
  });
}, 25_000);

test('a reply accepted without confirmation leaves a committed command recoverable without exactly-once claims', async () => {
  await withCommands(async (channel, replies) => {
    await stopUser();
    const gate = await brokerGate({
      hostname: String(brokerOptions.hostname),
      port: brokerOptions.port,
    });
    await withCleanup(async () => {
      gate.allow();
      gate.withholdConfirmations();
      await startUser({ RABBITMQ_PORT: gate.port });
      await send(channel, replies, baseline);
      expect(
        JSON.parse(
          (await receive(channel, replies)).content.toString(),
        ) as unknown,
      ).toHaveProperty('result.id');
      await until(() => gate.confirmations() > 0);
      gate.block();
      await stopUser();
      const command = await channel.get('user.create', { noAck: false });
      if (!command)
        throw new Error('Command ACK preceded the reply confirmation');
      expect(command.properties.messageId).toBe('create-profile-001');
      channel.nack(command, false, true);
      await startUser({ RABBITMQ_PORT: String(brokerOptions.port) });
      expect(
        JSON.parse(
          (await receive(channel, replies)).content.toString(),
        ) as unknown,
      ).toMatchObject({
        error: { code: 'USER.ALREADY_EXISTS' },
      });
      expect(
        (await ownerDatabase().query('SELECT * FROM users')).rowCount,
      ).toBe(1);
      expect(
        (await ownerDatabase().query('SELECT * FROM user_outbox')).rowCount,
      ).toBe(1);
    }, [() => withCleanup(stopUser, [() => gate.close()])]);
  });
}, 25_000);

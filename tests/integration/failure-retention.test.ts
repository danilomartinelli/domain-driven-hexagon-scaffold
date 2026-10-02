import { expect, test } from 'bun:test';
import { connect } from 'amqplib';
import { getHttpServer, user, wallet } from '@tests/setup/test-server';
import {
  assertTestEnvironment,
  readEnvironmentFile,
} from '../../database/environment';
import { runCommand as execute } from '../../scripts/lib/command';

const runCommand = (args: string[]) =>
  execute(args, { cwd: process.cwd(), timeout: 30_000 });
import { withCleanup } from '../../scripts/tests/cleanup';

async function broker() {
  const connection = await connect(
    {
      hostname: process.env.RABBITMQ_HOST,
      port: Number(process.env.RABBITMQ_PORT),
      username: process.env.RABBITMQ_USERNAME,
      password: process.env.RABBITMQ_PASSWORD,
      vhost: process.env.RABBITMQ_VHOST,
    },
    { timeout: 2_000 },
  );
  connection.on('error', () => {
    /* Promises report broker failures. */
  });
  return connection;
}

async function until(
  condition: () => boolean | Promise<boolean>,
): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!(await condition())) {
    if (Date.now() > deadline)
      throw new Error('Retained delivery condition timed out');
    await Bun.sleep(50);
  }
}

test('both poison-message paths retain original bytes and metadata through broker and service restart without mutation', async () => {
  assertTestEnvironment();
  const file = process.env.DDH_ENVIRONMENT_FILE;
  if (!file) throw new Error('Missing manifest');
  const manifest = readEnvironmentFile(file);
  const command = {
    type: 'user.create',
    version: 2,
    commandId: 'retained-command',
    correlationId: 'retained-correlation',
    data: {
      email: 'retention@example.com',
      country: 'England',
      street: 'Baker street',
      postalCode: 'NW16XE',
    },
  };
  const event = {
    type: 'user.created',
    version: 2,
    source: 'user',
    eventId: 'retained-event',
    occurredAt: '2026-09-30T12:00:00Z',
    correlationId: 'retained-correlation',
    causationId: 'retained-command',
    data: { userId: 'retained-user' },
  };
  const paths = [
    { queue: 'user.create', failed: 'user.create.failed', envelope: command },
    {
      queue: 'wallet.user-created',
      failed: 'wallet.user-created.failed',
      envelope: event,
    },
  ];
  const connection = await broker();
  await withCleanup(async () => {
    const channel = await connection.createConfirmChannel();
    await until(
      () =>
        user.output.includes('User command consumer connected.') &&
        wallet.output.includes('Wallet messaging connected.'),
    );
    for (const path of paths) {
      for (const body of [
        '{malformed-sensitive-payload',
        JSON.stringify(path.envelope),
      ]) {
        channel.sendToQueue(path.queue, Buffer.from(body), {
          persistent: true,
          mandatory: true,
          messageId: 'original-message',
          correlationId: 'original-correlation',
          headers: { trace: 'original-trace' },
        });
      }
    }
    await channel.waitForConfirms();
    await until(async () =>
      (
        await Promise.all(
          paths.map(
            async (path) =>
              (await channel.checkQueue(path.failed)).messageCount === 2,
          ),
        )
      ).every(Boolean),
    );
    expect(user.output + wallet.output).not.toContain(
      'malformed-sensitive-payload',
    );
    await user.stop();
    await wallet.stop();
  }, [() => connection.close()]);

  const selected = await runCommand([
    'docker',
    'ps',
    '-q',
    '--filter',
    `label=com.docker.compose.project=${manifest.project}`,
    '--filter',
    `label=dev.starter.owner=${manifest.owner}`,
    '--filter',
    'label=com.docker.compose.service=rabbitmq',
  ]);
  expect(selected.code).toBe(0);
  const id = selected.stdout.trim();
  if (!id || id.includes('\n')) throw new Error('Expected one owned broker');
  // Restart the broker application, retaining its disk. Disposable test volumes
  // are tmpfs; stopping the Docker container would deliberately discard them.
  await withCleanup(async () => {
    expect(
      (await runCommand(['docker', 'exec', id, 'rabbitmqctl', 'stop_app']))
        .code,
    ).toBe(0);
  }, [
    async () => {
      expect(
        (await runCommand(['docker', 'exec', id, 'rabbitmqctl', 'start_app']))
          .code,
      ).toBe(0);
    },
  ]);

  const recovered = await broker();
  await withCleanup(async () => {
    const channel = await recovered.createChannel();
    for (const path of paths) {
      expect((await channel.checkQueue(path.failed)).messageCount).toBe(2);
      const bodies: string[] = [];
      for (let i = 0; i < 2; i++) {
        const message = await channel.get(path.failed, { noAck: false });
        if (!message) throw new Error('Retained message lost during restart');
        bodies.push(message.content.toString());
        expect(message.properties).toMatchObject({
          messageId: 'original-message',
          correlationId: 'original-correlation',
          deliveryMode: 2,
          headers: { trace: 'original-trace' },
        });
      }
      expect(bodies.sort()).toEqual(
        ['{malformed-sensitive-payload', JSON.stringify(path.envelope)].sort(),
      );
    }
  }, [() => recovered.close()]);
  await user.start();
  await wallet.start();
  expect(
    (await getHttpServer().get('/v1/users').expect(200)).body,
  ).toMatchObject({ count: 0 });
  await getHttpServer().get('/v1/wallets/by-user/retained-user').expect(404);
  const final = await broker();
  await withCleanup(async () => {
    const channel = await final.createChannel();
    for (const path of paths) {
      expect((await channel.checkQueue(path.failed)).messageCount).toBe(2);
      expect((await channel.checkQueue(path.queue)).messageCount).toBe(0);
    }
  }, [() => final.close()]);
}, 60_000);

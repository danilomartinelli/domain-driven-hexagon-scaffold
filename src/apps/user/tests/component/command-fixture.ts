import {
  connect,
  type Channel,
  type ConfirmChannel,
  type GetMessage,
} from 'amqplib';
import { withCleanup } from '../../../../../scripts/tests/cleanup';
import { startUser, stopUser, userOutput } from './user-process';

export const brokerOptions = {
  hostname: process.env.RABBITMQ_HOST,
  port: Number(process.env.RABBITMQ_PORT),
  username: process.env.RABBITMQ_USERNAME,
  password: process.env.RABBITMQ_PASSWORD,
  vhost: process.env.RABBITMQ_VHOST,
};

export async function until(
  condition: () => boolean | Promise<boolean>,
): Promise<void> {
  const deadline = Date.now() + 12_000;
  while (!(await condition())) {
    if (Date.now() > deadline)
      throw new Error(`Command did not complete: ${userOutput()}`);
    await Bun.sleep(25);
  }
}

export async function withCommands(
  use: (channel: ConfirmChannel, replies: string) => Promise<void>,
): Promise<void> {
  const connection = await connect(brokerOptions, { timeout: 2_000 });
  await withCleanup(async () => {
    const channel = await connection.createConfirmChannel();
    await stopUser();
    await channel.assertExchange('user.commands', 'direct', { durable: true });
    for (const queue of ['user.create', 'user.create.failed']) {
      await channel.assertQueue(queue, { durable: true });
      await channel.purgeQueue(queue);
    }
    await channel.bindQueue('user.create', 'user.commands', 'user.create');
    const { queue: replies } = await channel.assertQueue('', {
      exclusive: true,
    });
    await startUser({ RABBITMQ_PORT: String(brokerOptions.port) });
    await use(channel, replies);
  }, [
    () =>
      withCleanup(
        () =>
          // Quiesce deliveries before restoring topology or truncating data.
          // Each cleanup owns a channel so one AMQP error cannot skip others.
          withCleanup(stopUser, [
            async () => {
              const cleanup = await connection.createChannel();
              // Topology-failure scenarios may leave an incompatible exchange.
              await cleanup.deleteExchange('user.commands');
              await cleanup.assertExchange('user.commands', 'direct', {
                durable: true,
              });
            },
            ...['user.create', 'user.create.failed', 'wallet.user-created'].map(
              (queue) => async () => {
                const cleanup = await connection.createChannel();
                await cleanup.assertQueue(queue, { durable: true });
                await cleanup.purgeQueue(queue);
              },
            ),
          ]),
        [() => connection.close()],
      ),
  ]);
}

export async function receive(
  channel: Channel,
  queue: string,
): Promise<GetMessage> {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    const message = await channel.get(queue, { noAck: true });
    if (message) return message;
    await Bun.sleep(25);
  }
  throw new Error(`Missing message on ${queue}: ${userOutput()}`);
}

export async function send(
  channel: ConfirmChannel,
  replies: string,
  body: unknown,
): Promise<void> {
  channel.publish(
    'user.commands',
    'user.create',
    Buffer.from(JSON.stringify(body)),
    {
      persistent: true,
      mandatory: true,
      replyTo: replies,
      messageId: 'create-profile-001',
      correlationId: 'signup-001',
      contentType: 'application/json',
    },
  );
  await channel.waitForConfirms();
}

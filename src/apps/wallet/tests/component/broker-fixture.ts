import { connect, type ConfirmChannel, type Options } from 'amqplib';
import { withCleanup } from '../../../../../scripts/tests/cleanup';
import { assertTestEnvironment } from '../../../../../database/environment';

// Literal baseline destination: changing production routing must not silently change this fixture.
export const destination = {
  exchange: 'user.events',
  routingKey: 'user.created.v1',
  queue: 'wallet.user-created',
  failed: 'wallet.user-created.failed',
};

export function brokerOptions(): {
  hostname: string;
  port: number;
  username: string;
  password: string;
  vhost: string;
  heartbeat: number;
} {
  const setting = (name: string): string => {
    const value = process.env[`RABBITMQ_${name}`];
    if (!value) throw new Error(`Missing RABBITMQ_${name}`);
    return value;
  };
  return {
    hostname: setting('HOST'),
    port: Number(setting('PORT')),
    username: setting('USERNAME'),
    password: setting('PASSWORD'),
    vhost: setting('VHOST'),
    heartbeat: 2,
  };
}

export async function withBroker<T>(
  use: (channel: ConfirmChannel) => Promise<T>,
): Promise<T> {
  assertTestEnvironment();
  const connection = await connect(brokerOptions(), { timeout: 2_000 });
  connection.on('error', () => {
    /* Closing a failed test connection must still attempt cleanup. */
  });
  return withCleanup(async () => {
    const channel = await connection.createConfirmChannel();
    channel.on('error', () => {
      /* Operations reject through their promises. */
    });
    await channel.assertExchange(destination.exchange, 'direct', {
      durable: true,
    });
    await channel.assertQueue(destination.queue, { durable: true });
    await channel.assertQueue(destination.failed, { durable: true });
    await channel.bindQueue(
      destination.queue,
      destination.exchange,
      destination.routingKey,
    );
    return await use(channel);
  }, [() => connection.close()]);
}

export function userCreated(eventId: string, userId: string): string {
  return JSON.stringify({
    type: 'user.created',
    version: 1,
    source: 'user',
    eventId,
    occurredAt: '2026-09-30T12:00:00Z',
    correlationId: `request-${eventId}`,
    causationId: `command-${eventId}`,
    data: { userId },
  });
}

export async function publish(
  channel: ConfirmChannel,
  body: string | Buffer,
  properties: Options.Publish = {},
): Promise<void> {
  const returns = new Set<unknown>();
  const onReturn = (message: unknown) => {
    returns.add(message);
  };
  channel.on('return', onReturn);
  try {
    channel.publish(
      destination.exchange,
      destination.routingKey,
      typeof body === 'string' ? Buffer.from(body) : body,
      {
        contentType: 'application/json',
        ...properties,
        persistent: true,
        mandatory: true,
      },
    );
    await channel.waitForConfirms();
    if (returns.size > 0) throw new Error('Publication was unroutable');
  } finally {
    channel.off('return', onReturn);
  }
}

/** Poll an observable condition, retaining the final assertion for diagnostics. */
export async function eventually(
  assertion: () => Promise<void>,
  timeout = 12_000,
): Promise<void> {
  const deadline = Date.now() + timeout;
  for (;;) {
    try {
      await assertion();
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await Bun.sleep(50);
    }
  }
}

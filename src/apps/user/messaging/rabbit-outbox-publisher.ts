import { setTimeout as delay } from 'node:timers/promises';
import { connect, type ConfirmChannel, type Options } from 'amqplib';
import type { LoggerPort } from '@starter/core/logger';
import { userCreatedDestination } from '@starter/integration-contracts/user-created';
import type {
  PendingPublication,
  UserOutbox,
} from '../application/outbox.port';

async function within<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(5_000)]);
  const failed = Promise.withResolvers<never>();
  const abort = () => {
    failed.reject(new Error('Publication interrupted or timed out'));
  };
  deadline.addEventListener('abort', abort, { once: true });
  if (deadline.aborted) abort();
  try {
    return await Promise.race([operation, failed.promise]);
  } finally {
    deadline.removeEventListener('abort', abort);
  }
}

/** Broker acceptance ends publication, never claims Wallet processing. */
export class RabbitOutboxPublisher {
  private readonly shutdown = new AbortController();
  private task?: Promise<void>;
  private retryMs = 250;

  constructor(
    private readonly options: Options.Connect,
    private readonly outbox: UserOutbox,
    private readonly logger: LoggerPort,
  ) {}

  start(): void {
    this.task ??= this.run();
  }

  async stop(): Promise<void> {
    this.shutdown.abort();
    await this.task;
  }

  private async run(): Promise<void> {
    const { signal } = this.shutdown;
    while (!signal.aborted) {
      try {
        await this.publishSession();
      } catch (error: unknown) {
        this.logger.warn(
          `User publication uncertain; pending work retries in ${String(this.retryMs)}ms.`,
          error,
        );
      }
      await delay(this.retryMs, undefined, { signal }).catch(() => undefined);
      this.retryMs = Math.min(this.retryMs * 2, 10_000);
    }
  }

  private async publishSession(): Promise<void> {
    const connection = await connect(this.options, { timeout: 2_000 });
    const session = new AbortController();
    const signal = AbortSignal.any([this.shutdown.signal, session.signal]);
    const end = () => {
      session.abort();
    };
    connection.on('error', end);
    connection.on('close', end);
    try {
      const channel = await within(connection.createConfirmChannel(), signal);
      channel.on('error', end);
      channel.on('close', end);
      // RabbitMQ sends mandatory returns before their confirms. Either invalidates
      // this session, including when an ACK follows an unroutable return.
      channel.on('return', end);
      const { exchange, routingKey, walletQueue } = userCreatedDestination;
      await within(
        (async () => {
          await channel.assertExchange(exchange, 'direct', { durable: true });
          await channel.assertQueue(walletQueue, { durable: true });
          await channel.bindQueue(walletQueue, exchange, routingKey);
        })(),
        signal,
      );
      this.logger.log('User publisher connected.');
      while (!signal.aborted) {
        const published = await this.outbox.publishNext(async (event) => {
          await this.publish(channel, event, signal);
          this.logger.log(
            'User event routed and broker-confirmed; Wallet completion is independent.',
            {
              eventId: event.eventId,
              correlationId: event.correlationId,
            },
          );
        });
        if (published) this.retryMs = 250;
        else await delay(250, undefined, { signal }).catch(() => undefined);
      }
    } finally {
      end();
      await within(connection.close(), new AbortController().signal).catch(
        () => undefined,
      );
    }
  }

  private async publish(
    channel: ConfirmChannel,
    event: PendingPublication,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    const confirmed = new Promise<void>((resolve, reject) => {
      channel.publish(
        userCreatedDestination.exchange,
        userCreatedDestination.routingKey,
        Buffer.from(event.body),
        {
          persistent: true,
          mandatory: true,
          contentType: 'application/json',
          messageId: event.eventId,
          correlationId: event.correlationId,
          type: 'user.created',
        },
        (error: unknown) => {
          if (error)
            reject(
              error instanceof Error
                ? error
                : new Error('Broker rejected publication'),
            );
          else resolve();
        },
      );
    });
    await within(confirmed, signal);
    signal.throwIfAborted();
  }
}

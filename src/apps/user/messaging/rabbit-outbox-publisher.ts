import { MessagingDiagnostics } from '@starter/rabbitmq/diagnostics';
import { setTimeout as delay } from 'node:timers/promises';
import { connect, type ConfirmChannel, type Options } from 'amqplib';
import type { LoggerPort } from '@starter/core/logger';
import { userCreatedDestination } from '@starter/integration-contracts/user-created';
import type {
  PendingPublication,
  UserOutbox,
} from '../application/outbox.port';

/** Optional AMQP short strings cannot carry every valid v1 JSON identity. */
function amqpIdentity(value: string): string | undefined {
  return Buffer.byteLength(value, 'utf8') <= 255 ? value : undefined;
}

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
  readonly diagnostics = new MessagingDiagnostics();
  private readonly shutdown = new AbortController();
  private task?: Promise<void>;
  private retryMs = 250;
  private currentEvent?: { eventId: string; correlationId: string };

  constructor(
    private readonly options: Options.Connect,
    private readonly outbox: UserOutbox,
    private readonly logger: LoggerPort,
  ) {}

  start(): void {
    this.task ??= this.run();
  }

  async stop(): Promise<void> {
    this.diagnostics.unavailable();
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
          {
            service: 'user',
            operation: 'outbox.failed',
            retryDelayMs: this.retryMs,
            ...this.currentEvent,
          },
        );
      }
      if (this.shutdown.signal.aborted) break;
      this.diagnostics.retry(this.retryMs);
      await delay(this.retryMs, undefined, { signal }).catch(() => undefined);
      this.retryMs = Math.min(this.retryMs * 2, 10_000);
    }
  }

  private async publishSession(): Promise<void> {
    this.currentEvent = undefined;
    const connection = await connect(this.options, { timeout: 2_000 });
    const session = new AbortController();
    // Stop claiming new work on shutdown, but let an accepted publication finish.
    const signal = session.signal;
    const accepting = AbortSignal.any([this.shutdown.signal, signal]);
    const end = () => {
      this.diagnostics.unavailable();
      session.abort();
    };
    connection.on('blocked', () => {
      this.diagnostics.setBlocked(true);
    });
    connection.on('unblocked', () => {
      this.diagnostics.setBlocked(false);
    });
    connection.on('error', end);
    connection.on('close', end);
    try {
      const channel = await within(
        connection.createConfirmChannel(),
        accepting,
      );
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
        accepting,
      );
      if (!accepting.aborted) this.diagnostics.available();
      this.logger.log('User publisher connected.', {
        service: 'user',
        operation: 'outbox.connected',
      });
      while (!accepting.aborted) {
        this.currentEvent = undefined;
        const published = await this.outbox.publishNext(async (event) => {
          this.currentEvent = {
            eventId: event.eventId,
            correlationId: event.correlationId,
          };
          await this.publish(channel, event, signal);
          this.logger.log(
            'User event routed and broker-confirmed; Wallet completion is independent.',
            {
              service: 'user',
              operation: 'outbox.confirmed',
              eventId: event.eventId,
              correlationId: event.correlationId,
            },
          );
        });
        if (published) {
          this.retryMs = 250;
          this.logger.log(
            'User publication completion committed.',
            { service: 'user', operation: 'outbox.published' },
            this.currentEvent,
          );
        } else
          await delay(250, undefined, { signal: accepting }).catch(
            () => undefined,
          );
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
          // The immutable envelope remains authoritative, including retained v1
          // Unicode identities that exceed the optional property's byte budget.
          messageId: amqpIdentity(event.eventId),
          correlationId: amqpIdentity(event.correlationId),
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

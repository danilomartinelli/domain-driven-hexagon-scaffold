import { setTimeout as delay } from 'node:timers/promises';
import {
  connect,
  type ConfirmChannel,
  type ConsumeMessage,
  type Options,
} from 'amqplib';
import type { LoggerPort } from '@starter/core/logger';
import { userCreatedDestination } from '@starter/integration-contracts/user-created';
import type { CreateWallet } from '../application/create-wallet';
import { handleUserCreated } from './user-created-consumer';

const initialRetryMs = 250;
const maxRetryMs = 10_000;

async function within<T>(
  operation: Promise<T>,
  milliseconds: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error('Messaging operation timed out'));
        }, milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** The HTTP lifecycle never waits for this independently recovering consumer. */
export class RabbitWalletConsumer {
  private readonly shutdown = new AbortController();
  private task?: Promise<void>;
  private retryMs = initialRetryMs;

  constructor(
    private readonly options: Options.Connect,
    private readonly create: CreateWallet,
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
        await this.consumeSession();
      } catch (error: unknown) {
        this.logger.warn(
          'Wallet messaging unavailable; deliveries remain unacknowledged.',
          error,
        );
      }
      if (this.shutdown.signal.aborted) break;
      this.logger.warn(
        `Wallet messaging reconnects in ${String(this.retryMs)}ms.`,
      );
      await delay(this.retryMs, undefined, { signal }).catch(() => undefined);
      this.retryMs = Math.min(this.retryMs * 2, maxRetryMs);
    }
  }

  private async consumeSession(): Promise<void> {
    const { signal } = this.shutdown;
    const connection = await connect(this.options, { timeout: 2_000 });
    let active = !signal.aborted;
    const ended = Promise.withResolvers<undefined>();
    const inFlight = new Set<Promise<void>>();
    const end = () => {
      active = false;
      ended.resolve(undefined);
    };
    connection.on('error', end);
    connection.on('close', end);
    signal.addEventListener('abort', end, { once: true });
    try {
      if (!active) return;
      const channel = await within(connection.createConfirmChannel(), 5_000);
      channel.on('error', end);
      channel.on('close', end);
      // A confirmation can accompany an unroutable return: both must succeed.
      channel.on('return', end);
      await within(
        this.subscribe(channel, (message) => {
          if (!message) {
            end();
            return;
          }
          if (!active) return;
          const processing = within(this.process(channel, message), 10_000)
            .then(() => {
              if (!active) return;
              channel.ack(message);
              // Reset only after successful work, never merely after reconnecting.
              this.retryMs = initialRetryMs;
            })
            .catch((error: unknown) => {
              this.logger.warn(
                'Wallet delivery failed; closing the channel for recovery.',
                error,
                {
                  messageId: optionalText(message.properties.messageId),
                  correlationId: optionalText(message.properties.correlationId),
                },
              );
              end();
            })
            .finally(() => {
              inFlight.delete(processing);
            });
          inFlight.add(processing);
        }),
        5_000,
      );
      this.logger.log('Wallet messaging connected.');
      await ended.promise;
    } finally {
      active = false;
      signal.removeEventListener('abort', end);
      // Closing requeues every unacknowledged delivery, including uncertain commits.
      await within(connection.close(), 5_000).catch(() => undefined);
      await Promise.allSettled(inFlight);
    }
  }

  private async subscribe(
    channel: ConfirmChannel,
    onMessage: (message: ConsumeMessage | null) => void,
  ): Promise<void> {
    const { exchange, routingKey, walletQueue, walletFailureQueue } =
      userCreatedDestination;
    await channel.assertExchange(exchange, 'direct', { durable: true });
    await channel.assertQueue(walletQueue, { durable: true });
    await channel.assertQueue(walletFailureQueue, { durable: true });
    await channel.bindQueue(walletQueue, exchange, routingKey);
    await channel.prefetch(4);
    await channel.consume(walletQueue, onMessage, { noAck: false });
  }

  private async process(
    channel: ConfirmChannel,
    message: ConsumeMessage,
  ): Promise<void> {
    const delivery = await handleUserCreated(message.content, this.create);
    if (delivery.accepted) {
      const { eventId, correlationId } = delivery.event;
      this.logger.log('Wallet event committed.', {
        eventId,
        correlationId,
        redelivered: message.fields.redelivered,
      });
      return;
    }
    // Preserve original bytes/identity. Do not carry expiration into the inspection queue.
    const properties = message.properties;
    channel.sendToQueue(
      userCreatedDestination.walletFailureQueue,
      message.content,
      {
        persistent: true,
        mandatory: true,
        messageId: optionalText(properties.messageId),
        correlationId: optionalText(properties.correlationId),
        contentType: optionalText(properties.contentType),
        contentEncoding: optionalText(properties.contentEncoding),
        type: optionalText(properties.type),
        headers: {
          ...properties.headers,
          'wallet-failure-reason': delivery.reason,
          'wallet-original-exchange': message.fields.exchange,
          'wallet-original-routing-key': message.fields.routingKey,
          'wallet-original-redelivered': message.fields.redelivered,
        },
      },
    );
    await channel.waitForConfirms();
    this.logger.warn('Wallet retained an invalid or unsupported event.');
  }
}

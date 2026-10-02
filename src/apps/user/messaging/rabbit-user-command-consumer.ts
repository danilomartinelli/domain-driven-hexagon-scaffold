import { MessagingDiagnostics } from '@starter/rabbitmq/diagnostics';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {
  connect,
  type ConfirmChannel,
  type ConsumeMessage,
  type Options,
} from 'amqplib';
import type { LoggerPort } from '@starter/core/logger';
import type { CreateUser } from '../application/create-user';
import {
  decodeUserCreateDelivery,
  userCreateDestination,
  type UserCreateResponse,
} from './user-create.contract';

async function within<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  milliseconds = 5_000,
): Promise<T> {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(milliseconds)]);
  const failed = Promise.withResolvers<never>();
  const abort = () => {
    failed.reject(new Error('User command messaging interrupted or timed out'));
  };
  deadline.addEventListener('abort', abort, { once: true });
  if (deadline.aborted) abort();
  try {
    return await Promise.race([operation, failed.promise]);
  } finally {
    deadline.removeEventListener('abort', abort);
  }
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Independent of HTTP middleware and of the outbox publisher's connection/retries. */
export class RabbitUserCommandConsumer {
  readonly diagnostics = new MessagingDiagnostics();
  private readonly shutdown = new AbortController();
  private task?: Promise<void>;
  private retryMs = 250;

  constructor(
    private readonly options: Options.Connect,
    private readonly create: CreateUser,
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
        await this.consumeSession();
      } catch (error: unknown) {
        this.logger.warn(
          'User commands unavailable; deliveries remain unacknowledged.',
          error,
          { service: 'user', operation: 'command.unavailable' },
        );
      }
      if (this.shutdown.signal.aborted) break;
      this.logger.warn(
        `User commands reconnect in ${String(this.retryMs)}ms.`,
        {
          service: 'user',
          operation: 'command.retry',
          retryDelayMs: this.retryMs,
        },
      );
      this.diagnostics.retry(this.retryMs);
      await delay(this.retryMs, undefined, { signal }).catch(() => undefined);
      this.retryMs = Math.min(this.retryMs * 2, 10_000);
    }
  }

  private async consumeSession(): Promise<void> {
    const connection = await connect(this.options, { timeout: 2_000 });
    const session = new AbortController();
    const signal = AbortSignal.any([this.shutdown.signal, session.signal]);
    const ended = Promise.withResolvers<undefined>();
    const inFlight = new Set<Promise<void>>();
    const end = () => {
      this.diagnostics.unavailable();
      session.abort();
      ended.resolve(undefined);
    };
    connection.on('blocked', () => {
      this.diagnostics.setBlocked(true);
    });
    connection.on('unblocked', () => {
      this.diagnostics.setBlocked(false);
    });
    connection.on('error', end);
    connection.on('close', end);
    signal.addEventListener('abort', end, { once: true });
    try {
      signal.throwIfAborted();
      const channel = await within(connection.createConfirmChannel(), signal);
      channel.on('error', end);
      channel.on('close', end);
      // Mandatory returns precede confirms; broker acceptance alone is insufficient.
      channel.on('return', end);
      const { exchange, queue, routingKey, failureQueue } =
        userCreateDestination;
      await within(
        (async () => {
          await channel.assertExchange(exchange, 'direct', { durable: true });
          await channel.assertQueue(queue, { durable: true });
          await channel.assertQueue(failureQueue, { durable: true });
          await channel.bindQueue(queue, exchange, routingKey);
          await channel.prefetch(1);
          await channel.consume(
            queue,
            (message) => {
              if (!message) {
                end();
                return;
              }
              if (signal.aborted) return;
              const processing = within(
                this.process(channel, message, signal),
                signal,
                15_000,
              )
                .then(() => {
                  signal.throwIfAborted();
                  channel.ack(message);
                  this.retryMs = 250;
                })
                .catch((error: unknown) => {
                  this.logger.warn(
                    'User command delivery failed; closing for recovery.',
                    error,
                    {
                      service: 'user',
                      operation: 'command.failed',
                      commandId: optionalText(message.properties.messageId),
                      correlationId: optionalText(
                        message.properties.correlationId,
                      ),
                    },
                  );
                  end();
                })
                .finally(() => {
                  inFlight.delete(processing);
                });
              inFlight.add(processing);
            },
            { noAck: false },
          );
        })(),
        signal,
      );
      if (!signal.aborted) this.diagnostics.available();
      this.logger.log('User command consumer connected.', {
        service: 'user',
        operation: 'command.connected',
      });
      await ended.promise;
    } finally {
      signal.removeEventListener('abort', end);
      end();
      // Closing requeues uncertain deliveries. A command retry can return email conflict.
      await within(connection.close(), new AbortController().signal).catch(
        () => undefined,
      );
      await Promise.allSettled(inFlight);
    }
  }

  private async process(
    channel: ConfirmChannel,
    message: ConsumeMessage,
    signal: AbortSignal,
  ): Promise<void> {
    const decoded = decodeUserCreateDelivery(
      message.content,
      message.properties,
    );
    if (!decoded.accepted) {
      await this.retain(channel, message, decoded.reason, signal);
      return;
    }
    const { commandId, correlationId, data } = decoded.command;
    const { replyTo } = decoded;
    signal.throwIfAborted();
    const createdAt = new Date();
    const eventId = randomUUID();
    const result = await this.create.execute(
      { ...data, id: randomUUID(), eventId, createdAt },
      { correlationId, causationId: commandId, timestamp: createdAt.getTime() },
    );
    signal.throwIfAborted();
    const response: UserCreateResponse = {
      type: 'user.create.result',
      version: 1,
      commandId,
      correlationId,
      ...(result.isOk()
        ? { result: { id: result.unwrap() } }
        : {
            error: {
              code: result.unwrapErr().code,
              message: result.unwrapErr().message,
            },
          }),
    };
    this.logger.log(
      result.isOk()
        ? 'User command committed.'
        : 'User command rejected by business rules.',
      {
        service: 'user',
        operation: result.isOk()
          ? 'user.create.committed'
          : 'user.create.rejected',
        ...(result.isOk() ? { eventId } : {}),
        commandId,
        correlationId,
      },
    );
    await this.send(
      channel,
      replyTo,
      Buffer.from(JSON.stringify(response)),
      {
        contentType: 'application/json',
        messageId: commandId,
        correlationId,
        type: response.type,
      },
      signal,
    );
  }

  private async retain(
    channel: ConfirmChannel,
    message: ConsumeMessage,
    reason: string,
    signal: AbortSignal,
  ): Promise<void> {
    const properties = message.properties;
    await this.send(
      channel,
      userCreateDestination.failureQueue,
      message.content,
      {
        messageId: optionalText(properties.messageId),
        correlationId: optionalText(properties.correlationId),
        replyTo: optionalText(properties.replyTo),
        contentType: optionalText(properties.contentType),
        contentEncoding: optionalText(properties.contentEncoding),
        type: optionalText(properties.type),
        headers: {
          ...properties.headers,
          'user-command-failure-reason': reason,
          'user-command-original-exchange': message.fields.exchange,
          'user-command-original-routing-key': message.fields.routingKey,
        },
      },
      signal,
    );
    this.logger.warn('User command retained for inspection.', {
      service: 'user',
      operation: 'command.retained',
      correlationId: optionalText(properties.correlationId),
      reason,
      commandId: optionalText(properties.messageId),
    });
  }

  private async send(
    channel: ConfirmChannel,
    queue: string,
    body: Buffer,
    properties: Options.Publish,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    channel.sendToQueue(queue, body, {
      ...properties,
      persistent: true,
      mandatory: true,
    });
    await within(channel.waitForConfirms(), signal);
    signal.throwIfAborted();
  }
}

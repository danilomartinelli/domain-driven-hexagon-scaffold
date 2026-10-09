import type { ConsumeMessage } from 'amqplib';
import type { LoggerPort } from '@starter/core/logger';
import type { MessagingSnapshot } from './diagnostics';
import {
  BrokerSession,
  SessionSupervisor,
  optionalText,
  within,
  type ConnectionOptions,
  type DeliveryIdentity,
} from './lib/session';
export type { ConnectionOptions, DeliveryIdentity } from './lib/session';
export type { MessagingSnapshot } from './diagnostics';

/** AMQP deliveries and fetched failure-queue messages both satisfy this contract. */
export interface Delivery {
  content: Buffer;
  properties: {
    messageId?: unknown;
    correlationId?: unknown;
    replyTo?: unknown;
    type?: unknown;
    contentType?: unknown;
    contentEncoding?: unknown;
    headers?: Record<string, unknown>;
  };
  fields: { exchange: string; routingKey: string; redelivered: boolean };
}

export interface MessageProperties {
  messageId?: string;
  correlationId?: string;
  replyTo?: string;
  type?: string;
  contentType?: string;
  contentEncoding?: string;
  headers?: Record<string, unknown>;
}

export type ConsumerOutcome =
  { status: 'completed' } | { status: 'retained'; reason: string };

export interface ConsumerContext {
  signal: AbortSignal;
  reply(
    queue: string,
    body: Buffer,
    properties?: MessageProperties,
  ): Promise<void>;
  /** Add decoded identity for logs without changing the original delivery. */
  identify(identity: DeliveryIdentity): void;
}

export interface ConsumerOptions {
  connection: ConnectionOptions;
  queue: string;
  failureQueue: string;
  binding?: { exchange: string; routingKey: string };
  prefetch: number;
  deliveryDeadlineMs: number;
  logger: LoggerPort;
  service: string;
  handler(
    delivery: Delivery,
    context: ConsumerContext,
  ): Promise<ConsumerOutcome>;
}

export class RabbitConsumer {
  private readonly supervisor: SessionSupervisor;

  constructor(private readonly options: ConsumerOptions) {
    this.supervisor = new SessionSupervisor(
      { ...options, role: 'consumer', destination: { queue: options.queue } },
      (session) => this.consume(session),
    );
  }

  start(): void {
    this.supervisor.start();
  }
  stop(): Promise<void> {
    return this.supervisor.stop();
  }
  snapshot(): MessagingSnapshot {
    return this.supervisor.diagnostics.snapshot();
  }

  private async consume(session: BrokerSession): Promise<void> {
    const { queue, failureQueue, binding, prefetch } = this.options;
    const { channel } = session;
    const inFlight = new Set<Promise<void>>();
    try {
      await session.operation(
        () => channel.assertQueue(queue, { durable: true }),
        session.accepting,
      );
      await session.operation(
        () => channel.assertQueue(failureQueue, { durable: true }),
        session.accepting,
      );
      if (binding) {
        await session.operation(
          () =>
            channel.assertExchange(binding.exchange, 'direct', {
              durable: true,
            }),
          session.accepting,
        );
        await session.operation(
          () => channel.bindQueue(queue, binding.exchange, binding.routingKey),
          session.accepting,
        );
      }
      await session.operation(
        () => channel.prefetch(prefetch),
        session.accepting,
      );
      session.accepting.throwIfAborted();
      const subscription = await session.operation(
        () =>
          channel.consume(
            queue,
            (message) => {
              if (!message) {
                session.end(new Error('Broker cancelled consumer'));
                return;
              }
              if (session.accepting.aborted) return;
              const draining = this.deliver(session, message).finally(() => {
                inFlight.delete(draining);
              });
              inFlight.add(draining);
            },
            { noAck: false },
          ),
        session.signal,
      );
      session.ready();
      await session.waitForStop();
      if (!session.signal.aborted)
        await session.operation(() => channel.cancel(subscription.consumerTag));
    } catch (error) {
      session.end(error);
    } finally {
      await Promise.allSettled(inFlight);
    }
  }

  private async deliver(
    session: BrokerSession,
    message: ConsumeMessage,
  ): Promise<void> {
    const identity: DeliveryIdentity = {
      messageId: optionalText(message.properties.messageId),
      correlationId: optionalText(message.properties.correlationId),
    };
    const deadline = new AbortController();
    const signal = AbortSignal.any([session.signal, deadline.signal]);
    const timer = setTimeout(() => {
      deadline.abort(new Error('Delivery deadline expired'));
    }, this.options.deliveryDeadlineMs);
    const operation = Promise.resolve().then(async () => {
      const outcome = await this.options.handler(message, {
        signal,
        identify: (decoded) => {
          for (const key of [
            'messageId',
            'correlationId',
            'eventId',
            'commandId',
          ] as const) {
            const value = optionalText(decoded[key]);
            if (value !== undefined) identity[key] = value;
          }
        },
        reply: (queue, body, properties) =>
          session.publish('', queue, body, properties ?? {}),
      });
      if (outcome.status === 'retained') {
        const properties = message.properties;
        await session.publish('', this.options.failureQueue, message.content, {
          messageId: optionalText(properties.messageId),
          correlationId: optionalText(properties.correlationId),
          replyTo: optionalText(properties.replyTo),
          contentType: optionalText(properties.contentType),
          contentEncoding: optionalText(properties.contentEncoding),
          type: optionalText(properties.type),
          headers: {
            ...properties.headers,
            'failure-reason': outcome.reason,
            'original-exchange': message.fields.exchange,
            'original-routing-key': message.fields.routingKey,
            'original-redelivered': message.fields.redelivered,
          },
        });
        this.supervisor.log('retained', {
          ...identity,
          reason: outcome.reason,
        });
      }
    });
    const acknowledgement = within(
      operation,
      signal,
      this.options.deliveryDeadlineMs,
    )
      .then(() => {
        signal.throwIfAborted();
        session.channel.ack(message);
        session.completed();
      })
      .catch((error: unknown) => {
        this.supervisor.log('failed', identity, error);
        session.end(error);
      })
      .finally(() => {
        clearTimeout(timer);
      });
    // A deadline cannot cancel effects. Both drain and reconnect await the real operation.
    await Promise.allSettled([operation, acknowledgement]);
  }
}

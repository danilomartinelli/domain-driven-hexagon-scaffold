import { setTimeout as delay } from 'node:timers/promises';
import type { LoggerPort } from '@starter/core/logger';
import type { MessagingSnapshot } from './lib/diagnostics';
import {
  BrokerSession,
  SessionSupervisor,
  type ConnectionOptions,
  type DeliveryIdentity,
} from './lib/session';
export type { ConnectionOptions } from './lib/session';
export type { MessagingSnapshot } from './lib/diagnostics';

export interface Publication {
  body: Buffer;
  messageId?: string;
  correlationId?: string;
  type?: string;
  contentType?: string;
}

export type Publish = (publication: Publication) => Promise<void>;

export interface PublisherOptions {
  connection: ConnectionOptions;
  exchange: string;
  routingKey: string;
  queues: string[];
  logger: LoggerPort;
  service: string;
  claim(publish: Publish): Promise<boolean>;
}

/** Optional AMQP short strings cannot carry every valid envelope identity. */
function amqpIdentity(value: string | undefined): string | undefined {
  return value !== undefined && Buffer.byteLength(value, 'utf8') <= 255
    ? value
    : undefined;
}

export class RabbitPublisher {
  private readonly supervisor: SessionSupervisor;

  constructor(private readonly options: PublisherOptions) {
    this.supervisor = new SessionSupervisor(
      {
        ...options,
        role: 'publisher',
        destination: { exchange: options.exchange },
      },
      (session) => this.publish(session),
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

  private async publish(session: BrokerSession): Promise<void> {
    const { exchange, routingKey, queues } = this.options;
    const { channel } = session;
    let identity: DeliveryIdentity = {};
    try {
      await session.operation(
        () => channel.assertExchange(exchange, 'direct', { durable: true }),
        session.accepting,
      );
      for (const queue of queues) {
        await session.operation(
          () => channel.assertQueue(queue, { durable: true }),
          session.accepting,
        );
        await session.operation(
          () => channel.bindQueue(queue, exchange, routingKey),
          session.accepting,
        );
      }
      session.ready();
      while (!session.accepting.aborted) {
        identity = {};
        const completed = await this.options.claim(async (publication) => {
          identity = {
            messageId: publication.messageId,
            eventId: publication.messageId,
            correlationId: publication.correlationId,
          };
          await session.publish(exchange, routingKey, publication.body, {
            messageId: amqpIdentity(publication.messageId),
            correlationId: amqpIdentity(publication.correlationId),
            contentType: publication.contentType,
            type: publication.type,
          });
        });
        identity = {};
        if (completed) session.completed();
        else
          await delay(250, undefined, { signal: session.accepting }).catch(
            () => undefined,
          );
      }
      session.signal.throwIfAborted();
    } catch (error) {
      this.supervisor.log('failed', identity, error);
      session.end(error);
    }
  }
}

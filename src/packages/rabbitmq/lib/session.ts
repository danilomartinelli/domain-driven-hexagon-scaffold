import {
  connect,
  type ChannelModel,
  type ConfirmChannel,
  type Options,
} from 'amqplib';
import { setTimeout as delay } from 'node:timers/promises';
import type { LoggerPort } from '@starter/core/logger';
import { MessagingDiagnostics } from '../diagnostics';

export type ConnectionOptions = Options.Connect | string;

export interface DeliveryIdentity {
  messageId?: string;
  correlationId?: string;
  eventId?: string;
  commandId?: string;
}

interface SessionOptions {
  connection: ConnectionOptions;
  logger: LoggerPort;
  service: string;
  role: 'consumer' | 'publisher';
  destination: { queue: string } | { exchange: string };
}

export function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export async function within<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  milliseconds = 5_000,
): Promise<T> {
  const failed = Promise.withResolvers<never>();
  const abort = () => {
    failed.reject(signal.reason);
  };
  const timer = setTimeout(() => {
    failed.reject(new Error('Messaging operation timed out'));
  }, milliseconds);
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  try {
    return await Promise.race([operation, failed.promise]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  }
}

/** A session owns broker handles; shutdown stops admission without cancelling work. */
export class BrokerSession {
  private readonly ended = new AbortController();
  readonly signal = this.ended.signal;
  readonly accepting: AbortSignal;
  private openedChannel?: ConfirmChannel;
  private closing?: Promise<void>;

  constructor(
    private readonly connection: ChannelModel,
    shutdown: AbortSignal,
    private readonly supervisor: SessionSupervisor,
  ) {
    this.accepting = AbortSignal.any([shutdown, this.signal]);
    connection.on('error', (error) => {
      this.end(error);
    });
    connection.on('close', () => {
      this.end(new Error('Broker connection closed'));
    });
    connection.on('blocked', () => {
      supervisor.diagnostics.setBlocked(true);
    });
    connection.on('unblocked', () => {
      supervisor.diagnostics.setBlocked(false);
    });
  }

  get channel(): ConfirmChannel {
    if (!this.openedChannel) throw new Error('Messaging channel is not open');
    return this.openedChannel;
  }

  async open(): Promise<void> {
    this.openedChannel = await this.operation(
      () => this.connection.createConfirmChannel(),
      this.accepting,
    );
    this.channel.on('error', (error) => {
      this.end(error);
    });
    this.channel.on('close', () => {
      this.end(new Error('Broker channel closed'));
    });
    // Mandatory returns precede confirms; even a subsequent ACK cannot accept them.
    this.channel.on('return', () => {
      this.end(new Error('Unroutable mandatory message'));
    });
  }

  operation<T>(perform: () => Promise<T>, signal = this.signal): Promise<T> {
    signal.throwIfAborted();
    return within(perform(), signal);
  }

  async publish(
    exchange: string,
    routingKey: string,
    body: Buffer,
    properties: Options.Publish,
  ): Promise<void> {
    try {
      await this.operation(
        () =>
          new Promise<void>((resolve, reject) => {
            this.channel.publish(
              exchange,
              routingKey,
              body,
              { ...properties, persistent: true, mandatory: true },
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
          }),
      );
      this.signal.throwIfAborted();
    } catch (error) {
      this.end(error);
      throw error;
    }
  }

  ready(): void {
    if (this.accepting.aborted) return;
    this.supervisor.diagnostics.available();
    this.supervisor.log('connected');
  }

  completed(): void {
    this.supervisor.completed();
  }

  async waitForStop(): Promise<void> {
    if (this.accepting.aborted) return;
    await new Promise<void>((resolve) => {
      this.accepting.addEventListener(
        'abort',
        () => {
          resolve();
        },
        { once: true },
      );
    });
  }

  end(error: unknown): void {
    if (this.signal.aborted || this.closing) return;
    this.supervisor.diagnostics.unavailable();
    this.supervisor.log('unavailable', {}, error);
    this.ended.abort(error);
    // Requeue uncertain deliveries now; the role still drains before reconnecting.
    void this.close();
  }

  close(): Promise<void> {
    this.closing ??= this.closeHandles();
    return this.closing;
  }

  private async closeHandles(): Promise<void> {
    this.supervisor.diagnostics.unavailable();
    const signal = new AbortController().signal;
    // Defer so intentional close events observe this.closing already assigned.
    await Promise.resolve();
    if (this.openedChannel)
      await within(this.openedChannel.close(), signal).catch(() => undefined);
    await within(this.connection.close(), signal).catch(() => undefined);
  }
}

/** The one connection, diagnostics and retry loop used by both messaging roles. */
export class SessionSupervisor {
  readonly diagnostics = new MessagingDiagnostics();
  private readonly shutdown = new AbortController();
  private task?: Promise<void>;
  private retryMs = 250;

  constructor(
    private readonly options: SessionOptions,
    private readonly work: (session: BrokerSession) => Promise<void>,
  ) {}

  start(): void {
    this.task ??= this.run();
  }

  async stop(): Promise<void> {
    this.diagnostics.unavailable();
    this.shutdown.abort();
    await this.task;
  }

  completed(): void {
    this.retryMs = 250;
  }

  log(
    operation: 'connected' | 'unavailable' | 'retry' | 'failed' | 'retained',
    identity: DeliveryIdentity & {
      reason?: string;
      retryDelayMs?: number;
    } = {},
    error?: unknown,
  ): void {
    const { logger, service, role, destination } = this.options;
    const fields = {
      service,
      ...destination,
      operation: `${role}.${operation}`,
      ...identity,
      ...(error === undefined
        ? {}
        : {
            errorType:
              error instanceof Error ? error.constructor.name : typeof error,
          }),
    };
    const message = `${role === 'consumer' ? 'Consumer' : 'Publisher'} ${operation}.`;
    if (operation === 'connected') logger.log(message, fields);
    else logger.warn(message, fields);
  }

  private async run(): Promise<void> {
    const signal = this.shutdown.signal;
    while (!signal.aborted) {
      let session: BrokerSession | undefined;
      try {
        const connection = await connect(this.options.connection, {
          timeout: 2_000,
        });
        session = new BrokerSession(connection, signal, this);
        await session.open();
        await this.work(session);
      } catch (error) {
        if (session) session.end(error);
        else if (!this.shutdown.signal.aborted)
          this.log('unavailable', {}, error);
      } finally {
        await session?.close();
      }
      if (this.shutdown.signal.aborted) break;
      this.diagnostics.retry(this.retryMs);
      this.log('retry', { retryDelayMs: this.retryMs });
      await delay(this.retryMs, undefined, { signal }).catch(() => undefined);
      this.retryMs = Math.min(this.retryMs * 2, 10_000);
    }
  }
}

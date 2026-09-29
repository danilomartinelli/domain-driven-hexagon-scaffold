import { AsyncLocalStorage } from 'node:async_hooks';
import type { DatabaseTransactionConnection } from 'slonik';

/**
 * Setting some isolated context for each request.
 */

export class AppRequestContext {
  requestId: string;
  transactionConnection?: DatabaseTransactionConnection; // For global transactions
}

export class RequestContextService {
  private static readonly storage = new AsyncLocalStorage<AppRequestContext>();

  static run<T>(callback: () => T): T {
    return this.storage.run(new AppRequestContext(), callback);
  }

  static getContext(): AppRequestContext {
    const ctx = this.storage.getStore();
    if (!ctx) throw new Error('Request context has not been initialized.');
    return ctx;
  }

  static setRequestId(id: string): void {
    const ctx = this.getContext();
    ctx.requestId = id;
  }

  static getRequestId(): string {
    return this.getContext().requestId;
  }

  static getTransactionConnection(): DatabaseTransactionConnection | undefined {
    const ctx = this.getContext();
    return ctx.transactionConnection;
  }

  static setTransactionConnection(
    transactionConnection?: DatabaseTransactionConnection,
  ): void {
    const ctx = this.getContext();
    ctx.transactionConnection = transactionConnection;
  }

  static cleanTransactionConnection(): void {
    const ctx = this.getContext();
    ctx.transactionConnection = undefined;
  }
}

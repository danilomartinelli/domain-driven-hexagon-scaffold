import { AsyncLocalStorage } from 'node:async_hooks';
import type { DatabaseTransactionConnection } from 'slonik';

/**
 * Setting some isolated context for each request.
 */

export class AppRequestContext {
  // Set by ContextInterceptor before commands and events are constructed.
  requestId!: string;
  transactionConnection?: DatabaseTransactionConnection; // For global transactions
}

const storage = new AsyncLocalStorage<AppRequestContext>();

export const RequestContextService = {
  run<T>(callback: () => T): T {
    return storage.run(new AppRequestContext(), callback);
  },

  getContext(): AppRequestContext {
    const ctx = storage.getStore();
    if (!ctx) throw new Error('Request context has not been initialized.');
    return ctx;
  },

  setRequestId(id: string): void {
    const ctx = this.getContext();
    ctx.requestId = id;
  },

  getRequestId(): string {
    return this.getContext().requestId;
  },

  getTransactionConnection(): DatabaseTransactionConnection | undefined {
    const ctx = this.getContext();
    return ctx.transactionConnection;
  },

  setTransactionConnection(
    transactionConnection?: DatabaseTransactionConnection,
  ): void {
    const ctx = this.getContext();
    ctx.transactionConnection = transactionConnection;
  },

  cleanTransactionConnection(): void {
    const ctx = this.getContext();
    ctx.transactionConnection = undefined;
  },
};

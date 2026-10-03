import { mock } from 'bun:test';
import { sql } from 'slonik';

const failure = process.env.FIXTURE_FAILURE;
let starts = 0;
await mock.module('../../../database/environment', () => ({
  assertTestEnvironment() {},
}));
await mock.module('slonik', () => ({
  sql,
  createPool: () => {
    let closed = false;
    return {
      query() {
        if (closed) throw new Error('POOL_CLOSED');
      },
      end() {
        if (closed) throw new Error('POOL_END_AGAIN');
        closed = true;
        console.log('POOL_ENDED');
        if (failure === 'cleanup') throw new Error('CLEANUP_FAILED');
      },
    };
  },
}));
await mock.module('amqplib', () => ({
  connect: () => ({
    createChannel: () => ({ assertQueue() {}, purgeQueue() {} }),
    close() {},
  }),
}));
await mock.module('../service-process', () => ({
  ServiceProcess: class {
    constructor(readonly name: string) {}
    start() {
      if (this.name !== 'user') return;
      starts++;
      if (failure === 'reset' ? starts === 2 : failure !== 'none') {
        throw new Error('STARTUP_FAILED');
      }
    }
    stop() {}
  },
}));
await import('../test-server');

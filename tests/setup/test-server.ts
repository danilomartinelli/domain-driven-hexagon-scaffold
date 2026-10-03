import { assertTestEnvironment } from '../../database/environment';
import { afterAll, afterEach, beforeAll, beforeEach } from 'bun:test';
import { createPool, sql, type DatabasePool } from 'slonik';
import { connect } from 'amqplib';
import request from 'supertest';
import { withCleanup } from '../../scripts/tests/cleanup';
import { ServiceProcess } from './service-process';

export const user = new ServiceProcess('user');
export const wallet = new ServiceProcess('wallet');
let userPool: DatabasePool | undefined;
let walletPool: DatabasePool | undefined;
let state: 'starting' | 'ready' | 'failed' | 'closed' = 'starting';
let failure: unknown;
export function getHttpServer(): ReturnType<typeof request> {
  return request(`http://127.0.0.1:${String(process.env.GATEWAY_PROXY_PORT)}`);
}
export function getTestDatabase(): DatabasePool {
  if (!userPool) throw new Error('User test database unavailable');
  return userPool;
}
export function getWalletDatabase(): DatabasePool {
  if (!walletPool) throw new Error('Wallet test database unavailable');
  return walletPool;
}

function uri(app: string): string {
  const setting = (key: string) =>
    encodeURIComponent(String(process.env[`${app}_DB_${key}`]));
  return `postgres://${setting('MIGRATION_USERNAME')}:${setting('MIGRATION_PASSWORD')}@${setting('HOST')}:${setting('PORT')}/${setting('NAME')}`;
}

async function reset(): Promise<void> {
  assertTestEnvironment();
  // Quiesce both producers and consumers before purging/truncating. No delivery
  // from this scenario can arrive after the next scenario's ownership starts.
  await withCleanup(async () => {
    await user.stop();
  }, [() => wallet.stop()]);
  const connection = await connect(
    {
      hostname: process.env.RABBITMQ_HOST,
      port: Number(process.env.RABBITMQ_PORT),
      username: process.env.RABBITMQ_USERNAME,
      password: process.env.RABBITMQ_PASSWORD,
      vhost: process.env.RABBITMQ_VHOST,
    },
    { timeout: 2_000 },
  );
  await withCleanup(async () => {
    const channel = await connection.createChannel();
    for (const queue of [
      'wallet.user-created',
      'wallet.user-created.failed',
      'user.create',
      'user.create.failed',
    ]) {
      await channel.assertQueue(queue, { durable: true });
      await channel.purgeQueue(queue);
    }
    await getTestDatabase().query(sql.unsafe`TRUNCATE users, user_outbox`);
    await getWalletDatabase().query(
      sql.unsafe`TRUNCATE wallets, wallet_consumed_events`,
    );
  }, [() => connection.close()]);
  await user.start();
  await wallet.start();
}

async function close(): Promise<void> {
  const pools = [userPool, walletPool];
  userPool = undefined;
  walletPool = undefined;
  if (state !== 'failed') state = 'closed';
  await withCleanup(
    async () => {
      await withCleanup(() => user.stop(), [() => wallet.stop()]);
    },
    pools.map((pool) => () => pool?.end()),
  );
}

async function prepare(operation: () => Promise<void>): Promise<void> {
  try {
    await operation();
    state = 'ready';
  } catch (error) {
    state = 'failed';
    failure = error;
    await withCleanup(() => {
      throw error;
    }, [close]);
  }
}

beforeAll(async () => {
  await prepare(async () => {
    assertTestEnvironment();
    userPool = await createPool(uri('USER'));
    walletPool = await createPool(uri('WALLET'));
    await reset();
  });
}, 30_000);
beforeEach(() => {
  if (state === 'failed') throw failure;
  if (state !== 'ready') throw new Error('Test environment is not ready');
});
afterEach(async () => {
  if (state === 'ready') await prepare(reset);
}, 30_000);
afterAll(close, 30_000);

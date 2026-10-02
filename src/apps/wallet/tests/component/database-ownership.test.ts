import { expect, test } from 'bun:test';
import pg from 'pg';
import { withCleanup } from '../../../../../scripts/tests/cleanup';
import { ownerDatabase, walletDatabase } from './wallet-process';

async function withClient<T>(
  config: pg.ClientConfig,
  use: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client(config);
  await client.connect();
  return withCleanup(() => use(client), [() => client.end()]);
}

/** The PostgreSQL SQLSTATE an operation fails with, or undefined on success. */
async function failure(operation: () => Promise<unknown>) {
  try {
    await operation();
    return undefined;
  } catch (error) {
    if (error instanceof pg.DatabaseError) return error.code;
    throw error;
  }
}

test('the runtime role reads and creates Wallets but cannot modify balances, delete data or change the schema', async () => {
  await ownerDatabase().query(
    `INSERT INTO wallets (id, "userId", balance) VALUES ('wallet-1', 'user-1', 0)`,
  );

  await withClient(walletDatabase('runtime'), async (runtime) => {
    const { rows } = await runtime.query(
      'SELECT id, "userId", balance FROM wallets',
    );
    expect(rows).toEqual([{ id: 'wallet-1', userId: 'user-1', balance: 0 }]);
    for (const statement of [
      'UPDATE wallets SET balance = 100',
      'DELETE FROM wallets',
      'TRUNCATE wallets',
      'CREATE TABLE deposits (id integer)',
      'ALTER TABLE wallets ADD COLUMN cancelled boolean',
      'SELECT name FROM pgmigrations',
      'DELETE FROM wallet_consumed_events',
      "UPDATE wallet_consumed_events SET user_id = 'other'",
    ]) {
      // insufficient_privilege
      expect(await failure(() => runtime.query(statement)), statement).toBe(
        '42501',
      );
    }
  });
  const { rows } = await ownerDatabase().query(
    'SELECT id, "userId", balance FROM wallets',
  );
  expect(rows).toEqual([{ id: 'wallet-1', userId: 'user-1', balance: 0 }]);
});

test('Wallet has its own schema and migration history', async () => {
  const history = await ownerDatabase().query<{ name: string }>(
    'SELECT name FROM pgmigrations ORDER BY id',
  );
  expect(history.rows.map((row) => row.name)).toEqual([
    '1790801127437_wallet-baseline',
    '1790807962923_wallet-consumed-events',
  ]);
  const tables = await ownerDatabase().query<{ name: string }>(
    `SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`,
  );
  expect(tables.rows.map((row) => row.name)).toEqual([
    'pgmigrations',
    'wallet_consumed_events',
    'wallets',
  ]);
});

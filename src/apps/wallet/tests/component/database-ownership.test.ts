import { expect, test } from 'bun:test';
import pg from 'pg';
import { readEnvironmentFile } from '../../../../../database/environment';
import { ownerDatabase, walletDatabase } from './wallet-process';

async function withClient<T>(
  config: pg.ClientConfig,
  use: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client(config);
  await client.connect();
  try {
    return await use(client);
  } finally {
    await client.end();
  }
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

test('the runtime role reads Wallets but cannot write them, change the schema or read migration history', async () => {
  await ownerDatabase().query(
    `INSERT INTO wallets (id, "userId", balance) VALUES ('wallet-1', 'user-1', 0)`,
  );

  await withClient(walletDatabase('runtime'), async (runtime) => {
    const { rows } = await runtime.query(
      'SELECT id, "userId", balance FROM wallets',
    );
    expect(rows).toEqual([{ id: 'wallet-1', userId: 'user-1', balance: 0 }]);
    for (const statement of [
      `INSERT INTO wallets (id, "userId") VALUES ('wallet-2', 'user-2')`,
      'UPDATE wallets SET balance = 100',
      'DELETE FROM wallets',
      'TRUNCATE wallets',
      'CREATE TABLE deposits (id integer)',
      'ALTER TABLE wallets ADD COLUMN cancelled boolean',
      'SELECT name FROM pgmigrations',
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
  ]);
  const tables = await ownerDatabase().query<{ name: string }>(
    `SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`,
  );
  expect(tables.rows.map((row) => row.name)).toEqual([
    'pgmigrations',
    'wallets',
  ]);
});

test('Wallet runtime and migration credentials cannot reach the other configured application databases', async () => {
  const environmentFile = process.env.DDH_ENVIRONMENT_FILE;
  if (!environmentFile) throw new Error('Missing DDH_ENVIRONMENT_FILE');
  const others = readEnvironmentFile(environmentFile).databases.filter(
    (db) => db.app !== 'wallet',
  );
  expect(others.length).toBeGreaterThan(0);

  for (const other of others) {
    for (const role of ['runtime', 'owner'] as const) {
      const { user, password } = walletDatabase(role);
      const target = {
        host: other.host,
        port: other.port,
        database: other.database,
        user,
        password,
      };
      // invalid_password, invalid_authorization_specification or insufficient_privilege
      expect(
        await failure(() =>
          withClient(target, (client) => client.query('SELECT 1')),
        ),
        `${role} -> ${other.app}`,
      ).toBeOneOf(['28P01', '28000', '42501']);
    }
  }
});

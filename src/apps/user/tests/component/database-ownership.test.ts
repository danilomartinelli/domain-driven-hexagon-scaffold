import { expect, test } from 'bun:test';
import pg from 'pg';
import { withCleanup } from '../../../../../scripts/tests/cleanup';
import { ownerDatabase, userDatabase } from './user-process';

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

test('runtime credentials allow profile operations and pending insertion but cannot cancel events or migrate', async () => {
  await withClient(userDatabase('runtime'), async (runtime) => {
    await runtime.query('SELECT * FROM users');
    await runtime.query('SELECT * FROM user_outbox');
    for (const statement of [
      'TRUNCATE users',
      'CREATE TABLE forbidden (id integer)',
      'ALTER TABLE users ADD COLUMN forbidden boolean',
      'SELECT name FROM pgmigrations',
      'DELETE FROM user_outbox',
      'UPDATE user_outbox SET envelope = envelope',
    ])
      expect(await failure(() => runtime.query(statement)), statement).toBe(
        '42501',
      );
  });
});

test('User has its own schema and migration history', async () => {
  const history = await ownerDatabase().query<{ name: string }>(
    'SELECT name FROM pgmigrations ORDER BY id',
  );
  expect(history.rows.map((row) => row.name)).toEqual([
    '1790813453459_user-baseline',
    '1790813453460_user-publication',
  ]);
  const tables = await ownerDatabase().query<{ name: string }>(
    `SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`,
  );
  expect(tables.rows.map((row) => row.name)).toEqual([
    'pgmigrations',
    'user_outbox',
    'users',
  ]);
});

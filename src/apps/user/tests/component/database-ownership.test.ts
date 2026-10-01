import { expect, test } from 'bun:test';
import pg from 'pg';
import { readEnvironmentFile } from '../../../../../database/environment';
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

test('User runtime and migration credentials cannot reach the other configured application databases', async () => {
  const environmentFile = process.env.DDH_ENVIRONMENT_FILE;
  if (!environmentFile) throw new Error('Missing DDH_ENVIRONMENT_FILE');
  const others = readEnvironmentFile(environmentFile).databases.filter(
    (db) => db.app !== 'user',
  );
  expect(others.length).toBeGreaterThan(0);

  for (const other of others) {
    for (const role of ['runtime', 'owner'] as const) {
      const { user, password } = userDatabase(role);
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

test('effective Wallet runtime credentials cannot read or write the final User database', async () => {
  for (const statement of [
    'SELECT * FROM users',
    'DELETE FROM users',
    'SELECT * FROM user_outbox',
  ]) {
    expect(
      await failure(() =>
        withClient(
          {
            ...userDatabase('runtime'),
            user: process.env.WALLET_DB_USERNAME,
            password: process.env.WALLET_DB_PASSWORD,
          },
          (client) => client.query(statement),
        ),
      ),
    ).toBeOneOf(['28P01', '28000', '42501']);
  }
});

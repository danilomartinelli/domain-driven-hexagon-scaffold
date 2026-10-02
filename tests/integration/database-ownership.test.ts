import { expect, test } from 'bun:test';
import pg from 'pg';
import {
  assertTestEnvironment,
  readEnvironmentFile,
} from '../../database/environment';
import { withCleanup } from '../../scripts/tests/cleanup';

test('runtime and migration credentials cannot access the sibling database in either direction', async () => {
  assertTestEnvironment();
  const file = process.env.DDH_ENVIRONMENT_FILE;
  if (!file) throw new Error('Missing owned manifest');
  const { databases } = readEnvironmentFile(file);
  expect(databases.map((db) => db.app).sort()).toEqual(['user', 'wallet']);
  for (const own of databases) {
    if (!own.runtime)
      throw new Error('Expected restricted runtime credentials');
    for (const other of databases.filter((db) => db.app !== own.app)) {
      for (const role of [own, own.runtime]) {
        for (const statement of other.app === 'user'
          ? [
              'SELECT * FROM users',
              'DELETE FROM users',
              'SELECT * FROM user_outbox',
            ]
          : [
              'SELECT * FROM wallets',
              'DELETE FROM wallets',
              'SELECT * FROM wallet_consumed_events',
            ]) {
          const client = new pg.Client({
            host: other.host,
            port: other.port,
            database: other.database,
            user: role.username,
            password: role.password,
            connectionTimeoutMillis: 2_000,
          });
          await withCleanup(async () => {
            let code: string | undefined;
            try {
              await client.connect();
              await client.query(statement);
            } catch (error) {
              if (!(error instanceof pg.DatabaseError)) throw error;
              code = error.code;
            }
            expect(
              code,
              `${role.username} -> ${other.app}: ${statement}`,
            ).toBeOneOf(['28P01', '28000', '42501']);
          }, [() => client.end()]);
        }
      }
    }
  }
});

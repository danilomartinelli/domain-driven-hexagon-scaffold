import process from 'node:process';
import console from 'node:console';
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Migration, runner } from 'node-pg-migrate';
import pg from 'pg';

const migrationsDir = fileURLToPath(new URL('./migrations/', import.meta.url));

async function run() {
  const [command, name, ...extra] = process.argv.slice(2);
  if (command === 'create' && name && !extra.length) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
      throw new Error('Use a migration name like add-user-index.');
    }
    console.log(
      await Migration.create(name, migrationsDir, { language: 'sql' }),
    );
    return;
  }
  if (
    (command !== 'up' && command !== 'down' && command !== 'status') ||
    name
  ) {
    throw new Error(
      'Usage: bun database/migrate.mjs create <name> | up | down | status',
    );
  }

  const { postgresConnectionUri } =
    await import('../src/configs/database.config.ts');
  if (command !== 'status') {
    await runner({
      databaseUrl: postgresConnectionUri,
      dir: migrationsDir,
      ignorePattern: '(?!.*\\.sql$).*',
      migrationsTable: 'pgmigrations',
      migrationsSchema: 'public',
      schema: 'public',
      direction: command,
      count: command === 'down' ? 1 : undefined,
      singleTransaction: true,
      checkOrder: true,
      noLock: false,
    });
    return;
  }

  const client = new pg.Client({ connectionString: postgresConnectionUri });
  try {
    await client.connect();
    /** @type {import('pg').QueryResult<{ history: string | null }>} */
    const { rows } = await client.query(
      "SELECT to_regclass('public.pgmigrations') AS history",
    );
    /** @type {string[]} */
    let applied = [];
    if (rows[0].history) {
      /** @type {import('pg').QueryResult<{ name: string }>} */
      const history = await client.query(
        'SELECT name FROM public.pgmigrations ORDER BY id',
      );
      applied = history.rows.map((row) => row.name);
    }
    const files = (await readdir(migrationsDir))
      .filter((file) => file.endsWith('.sql'))
      .sort()
      .map((file) => file.slice(0, -4));
    for (const migration of files) {
      console.log(
        `${applied.includes(migration) ? 'applied' : 'pending'}\t${migration}`,
      );
    }
    for (const migration of applied.filter(
      (migration) => !files.includes(migration),
    )) {
      console.log(`missing file\t${migration}`);
    }
  } finally {
    await client.end();
  }
}

run().catch((/** @type {unknown} */ error) => {
  console.error(error);
  process.exitCode = 1;
});

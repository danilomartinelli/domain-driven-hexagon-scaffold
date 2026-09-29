import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { postgresConnectionUri } from '../src/configs/database.config.ts';

async function seed() {
  const client = new pg.Client({ connectionString: postgresConnectionUri });
  try {
    await client.connect();
    await client.query('BEGIN');
    try {
      for (const file of ['users.seed.sql', 'wallets.seed.sql']) {
        const sql = await readFile(
          new URL(`./seeds/${file}`, import.meta.url),
          'utf8',
        );
        await client.query(sql);
        console.log(`Loaded ${file}`);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
    console.log('Seeds committed.');
  } finally {
    await client.end();
  }
}

seed().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

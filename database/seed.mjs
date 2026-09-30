import process from 'node:process';
import console from 'node:console';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { databaseTarget } from './target.ts';

async function seed() {
  const { app, connection } = databaseTarget();
  const client = new pg.Client(connection);
  try {
    await client.connect();
    await client.query('BEGIN');
    try {
      for (const file of app.seeds) {
        const sql = await readFile(file, 'utf8');
        await client.query(sql);
        console.log(`Loaded ${file.pathname}`);
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

seed().catch((/** @type {unknown} */ error) => {
  console.error(error);
  process.exitCode = 1;
});

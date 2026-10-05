import { Client } from 'pg';
import { activeDatabases, readEnvironmentFile } from '../database/environment';

// Called after ownership verification and database health, including on existing clusters.
const manifest = readEnvironmentFile(process.argv[2]);
for (const db of activeDatabases(manifest)) {
  if (!db.runtime) continue;
  const client = new Client({
    host: db.host,
    port: db.port,
    user: db.username,
    password: db.password,
    database: db.database,
    connectionTimeoutMillis: 5000,
    statement_timeout: 10000,
  });
  try {
    await client.connect();
    const existing = await client.query(
      'SELECT 1 FROM pg_roles WHERE rolname = $1',
      [db.runtime.username],
    );
    if (!existing.rowCount) {
      const name = '"' + db.runtime.username.replaceAll('"', '""') + '"';
      const password = "'" + db.runtime.password.replaceAll("'", "''") + "'";
      await client.query(`CREATE ROLE ${name} LOGIN PASSWORD ${password}`);
    }
  } finally {
    await client.end();
  }
}

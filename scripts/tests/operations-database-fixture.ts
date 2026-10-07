import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runCommand } from '../lib/command';
import { provisionDatabase } from '../lib/operations-compose';
import {
  writeJson,
  type Artifact,
  type InstallationState,
} from '../lib/operations-config';
import { until } from './app-runtime-fixture';
import { removeOwnedContainer } from './owned-container';
import { withCleanup } from './cleanup';

/** Exercise archive recovery against a disposable owning PostgreSQL database. */
export async function operationsDatabaseFixture(): Promise<{
  directory: string;
  app: Artifact;
  state: InstallationState;
  compose: (args: string[]) => Promise<string>;
  sql: (query: string) => Promise<string>;
  cleanup: () => Promise<void>;
}> {
  const owner = randomUUID();
  const project = `ddh-ops-recovery-${owner}`;
  const directory = resolve('.context/test-runs', project);
  const secrets = join(directory, 'secrets');
  mkdirSync(secrets, { recursive: true, mode: 0o700 });
  for (const role of ['admin', 'owner', 'runtime'])
    writeFileSync(join(secrets, `user-${role}-password`), `${randomUUID()}\n`, {
      mode: 0o444,
    });
  const image = `example/user@sha256:${'a'.repeat(64)}`;
  const app = {
    image,
    declaration: {
      name: 'user',
      persistence: true,
      messaging: false,
      exposure: false,
    },
  };
  const state: InstallationState = {
    version: 2,
    name: 'recovery',
    project,
    owner,
    directory,
    applied: { applications: [app] },
    retained: { databases: [] },
  };
  const container = { name: `${project}-postgres`, owner };
  const composePath = join(directory, 'compose.json');
  writeJson(composePath, {
    services: {
      'postgres-user': {
        image: 'postgres:18.6-alpine',
        container_name: container.name,
        labels: { 'dev.starter.owner': owner },
        network_mode: 'none',
        environment: {
          POSTGRES_DB: 'user',
          POSTGRES_PASSWORD_FILE: '/run/secrets/user-admin-password',
        },
        volumes: [`${secrets}:/run/secrets:ro`],
        tmpfs: ['/var/lib/postgresql'],
      },
      'app-user': { image, profiles: ['applications'], network_mode: 'none' },
    },
  });
  const compose = async (args: string[]) => {
    const result = await runCommand(
      ['docker', 'compose', '-p', project, '-f', composePath, ...args],
      { cwd: directory, timeout: 60_000 },
    );
    if (result.code !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  const sql = (query: string) =>
    compose([
      'exec',
      '-T',
      'postgres-user',
      'psql',
      '-X',
      '-U',
      'user_owner',
      '-d',
      'user',
      '-v',
      'ON_ERROR_STOP=1',
      '-At',
      '-c',
      query,
    ]);
  const cleanup = () => removeOwnedContainer(container);
  try {
    await compose(['up', '-d', 'postgres-user']);
    await until(async () =>
      compose([
        'exec',
        '-T',
        'postgres-user',
        'pg_isready',
        '-h',
        '127.0.0.1',
        '-U',
        'postgres',
        '-d',
        'user',
      ]).then(
        () => true,
        () => false,
      ),
    );
    await compose([
      'exec',
      '-T',
      'postgres-user',
      'sh',
      '-ec',
      provisionDatabase('user'),
    ]);
    await sql(
      "CREATE TABLE users (id integer PRIMARY KEY); INSERT INTO users VALUES (1); CREATE TABLE pgmigrations (id integer PRIMARY KEY, name text); INSERT INTO pgmigrations VALUES (1, 'baseline'); GRANT SELECT ON users TO user_runtime;",
    );
    return { directory, app, state, compose, sql, cleanup };
  } catch (error) {
    return withCleanup(() => {
      throw error;
    }, [cleanup]);
  }
}

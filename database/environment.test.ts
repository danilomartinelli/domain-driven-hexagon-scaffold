import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { environmentLocation, readEnvironment } from './environment';

/**
 * A stopped manifest written before service and volume names were recorded;
 * `scripts/tests/environment-identities.test.ts` runs the same shape through the runner.
 */
function olderManifest(environment: 'development' | 'test', run: string) {
  const { project } = environmentLocation(environment, run);
  const database = (app: string, port: number) => ({
    app,
    prefix: `${app.toUpperCase()}_DB`,
    host: '127.0.0.1',
    port,
    username: 'starter',
    password: `${app}-owner-secret`,
    database: `${project.replaceAll('-', '_')}_${app}`,
    runtime: { username: `${app}_runtime`, password: `${app}-runtime-secret` },
  });
  return {
    environment,
    run,
    project,
    owner: randomUUID(),
    status: 'stopped',
    apps: ['user'],
    topology: [
      { name: 'user', persistence: true, messaging: true, exposure: false },
    ],
    applicationPorts: { user: 41001 },
    // Wallet's database stays retained after its application was excluded.
    databases: [database('user', 41002), database('wallet', 41003)],
    broker: {
      port: 41004,
      managementPort: 41005,
      username: 'starter',
      password: 'broker-secret',
      vhost: project,
    },
  };
}

/** Read a manifest after one edit to its recorded inventory. */
function readRecorded(
  environment: 'development' | 'test',
  edit: (manifest: ReturnType<typeof olderManifest>) => void = () => undefined,
) {
  // Reading requires the run's own path; the fixture prefix identifies a test-owned run.
  const run = `fixture-${randomUUID().slice(0, 8)}`;
  const location = environmentLocation(environment, run);
  const manifest = olderManifest(environment, run);
  edit(manifest);
  const recorded = JSON.stringify(manifest);
  try {
    mkdirSync(location.directory, { recursive: true });
    writeFileSync(location.manifestPath, recorded);
    const read = readEnvironment(environment, run, { complete: false });
    // Reading completes the inventory in memory only.
    expect(readFileSync(location.manifestPath, 'utf8')).toBe(recorded);
    return read;
  } finally {
    rmSync(location.directory, { recursive: true, force: true });
  }
}

const identities = (manifest: ReturnType<typeof readRecorded>) => ({
  databases: manifest.databases.map(({ app, service, volume }) => ({
    app,
    service,
    volume,
  })),
  broker: manifest.broker?.volume,
});

test('older development manifests are completed with the names they were provisioned with', () => {
  expect(identities(readRecorded('development'))).toEqual({
    databases: [
      { app: 'user', service: 'postgres-user', volume: 'user-postgres' },
      { app: 'wallet', service: 'postgres-wallet', volume: 'wallet-postgres' },
    ],
    broker: 'rabbitmq',
  });
});

test('older test manifests are completed without storage volumes', () => {
  const manifest = readRecorded('test');
  expect(identities(manifest)).toEqual({
    databases: [
      { app: 'user', service: 'postgres-user', volume: undefined },
      { app: 'wallet', service: 'postgres-wallet', volume: undefined },
    ],
    broker: undefined,
  });
  expect(manifest.databases[0]).not.toHaveProperty('volume');
  expect(manifest.broker).not.toHaveProperty('volume');
});

for (const { name, environment, edit, error } of [
  {
    name: 'a database name',
    environment: 'development' as const,
    edit: (manifest: ReturnType<typeof olderManifest>) => {
      manifest.databases[0].database = 'foreign_user';
    },
    error: 'Database is not scoped to the selected application and run.',
  },
  {
    name: 'a database service',
    environment: 'development' as const,
    edit: (manifest: ReturnType<typeof olderManifest>) => {
      Object.assign(manifest.databases[0], { service: 'postgres-foreign' });
    },
    error: 'Database is not scoped to the selected application and run.',
  },
  {
    name: 'a database volume',
    environment: 'development' as const,
    edit: (manifest: ReturnType<typeof olderManifest>) => {
      Object.assign(manifest.databases[1], { volume: 'foreign-postgres' });
    },
    error: 'Database is not scoped to the selected application and run.',
  },
  {
    name: 'a test database volume',
    environment: 'test' as const,
    edit: (manifest: ReturnType<typeof olderManifest>) => {
      Object.assign(manifest.databases[0], { volume: 'user-postgres' });
    },
    error: 'Database is not scoped to the selected application and run.',
  },
  {
    name: 'a broker volume',
    environment: 'development' as const,
    edit: (manifest: ReturnType<typeof olderManifest>) => {
      Object.assign(manifest.broker, { volume: 'foreign-rabbitmq' });
    },
    error: 'Broker or gateway belongs to another run.',
  },
])
  test(`a manifest recording ${name} outside its run's naming is refused`, () => {
    expect(() => readRecorded(environment, edit)).toThrow(error);
  });

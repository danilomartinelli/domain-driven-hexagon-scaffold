import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import {
  environmentPrefix,
  runtimeRole,
} from '@starter/capabilities/declaration';
import {
  environmentLocation,
  type EnvironmentManifest,
} from '../../../database/environment';
import { applicationContainer } from '../../lib/application-containers';
import { composeConfiguration } from '../../lib/compose';
import { runCommand } from '../../lib/command';
import { operateEnvironment } from '../../lib/environments';
import { withCleanup } from '../cleanup';
import { removeOwnedContainer } from '../owned-container';

const scenario = process.argv[2];
const location = environmentLocation('development', 'cleanup');
const names = ['user', 'user-audit', 'user-db', 'user-http', 'rabbitmq-client'];
const manifest: EnvironmentManifest = {
  environment: 'development',
  run: 'cleanup',
  project: location.project,
  owner: randomUUID(),
  status: 'ready',
  databases: [],
  applicationPorts: Object.fromEntries(
    names.map((name, index) => [name, 3000 + index]),
  ),
  topology: names.map((name) => ({
    name,
    persistence: true,
    messaging: true,
    exposure: false,
    routes: [],
  })),
};

if (scenario === 'credentials') {
  manifest.databases = names.map((name, index) => ({
    app: name,
    prefix: `${environmentPrefix(name)}_DB`,
    host: '127.0.0.1',
    port: 5400 + index,
    username: 'fixture-owner',
    password: 'fixture-owner-password',
    database: name,
    runtime: { username: runtimeRole(name), password: 'fixture-runtime' },
  }));
  manifest.broker = {
    port: 5672,
    managementPort: 15672,
    username: 'fixture',
    password: 'fixture-broker',
    vhost: manifest.project,
  };
  process.env.USER_CUSTOM_SETTING = 'own-setting';
  const container = applicationContainer(manifest, 'user');
  const keys = Object.keys(container.environment ?? {});
  assert(keys.includes('USER_DB_PASSWORD'));
  assert(keys.includes('USER_HTTP_PORT'));
  assert(keys.includes('USER_RABBITMQ_URL'));
  assert(keys.includes('USER_CUSTOM_SETTING'));
  assert(!keys.includes('USER_DB_DB_PASSWORD'));
  assert(!keys.includes('USER_HTTP_DB_PASSWORD'));
  assert(!keys.some((key) => key.includes('_MIGRATION_')));
  assert.deepEqual(
    keys.filter(
      (key) =>
        key.startsWith('USER_AUDIT_') || key.startsWith('RABBITMQ_CLIENT_'),
    ),
    [],
  );
  for (const name of names) {
    const directory = join('src/apps', name);
    mkdirSync(directory, { recursive: true });
    if (name !== 'user')
      writeFileSync(join(directory, 'distribution.json'), '[]');
    const prefix = environmentPrefix(name);
    const appKeys = Object.keys(
      applicationContainer(manifest, name).environment ?? {},
    );
    for (const other of names) {
      const otherPrefix = environmentPrefix(other);
      for (const suffix of [
        'DB_PASSWORD',
        'DB_USERNAME',
        'HTTP_PORT',
        'RABBITMQ_URL',
      ])
        assert.equal(
          appKeys.includes(`${otherPrefix}_${suffix}`),
          otherPrefix === prefix,
          `${name} must only receive its own ${suffix}`,
        );
    }
    assert(appKeys.includes('RABBITMQ_HOST'));
  }
  const disabled = {
    ...manifest,
    topology: manifest.topology?.map((app) =>
      app.name === 'user-db'
        ? { ...app, persistence: false, messaging: false }
        : app,
    ),
  };
  const disabledKeys = Object.keys(
    applicationContainer(disabled, 'user-db').environment ?? {},
  );
  assert(!disabledKeys.includes('USER_DB_PASSWORD'));
  assert(!disabledKeys.includes('USER_DB_DB_PASSWORD'));
} else {
  manifest.topology = [
    {
      name: 'user',
      persistence: false,
      messaging: false,
      exposure: false,
      routes: [],
    },
  ];
  mkdirSync(location.directory, { recursive: true });
  writeFileSync(location.manifestPath, JSON.stringify(manifest));
  const composePath = join(location.directory, 'fixture-compose.json');
  const config = composeConfiguration(manifest);
  writeFileSync(
    composePath,
    JSON.stringify({
      ...config,
      services: {
        'app-user': {
          ...applicationContainer(manifest, 'user'),
          image: 'postgres:18.6-alpine',
          entrypoint: ['sh', '-c'],
          command: ["trap 'exit 0' TERM; while :; do sleep 1 & wait $$!; done"],
          healthcheck: { disable: true },
        },
      },
    }),
  );
  const execute = async (args: string[]) => {
    const result = await runCommand(args, {
      cwd: process.cwd(),
      timeout: 60_000,
    });
    assert.equal(result.code, 0, result.stdout + result.stderr);
    return result.stdout.trim();
  };
  const compose = [
    'docker',
    'compose',
    '-p',
    manifest.project,
    '-f',
    composePath,
    '--profile',
    'applications',
  ];
  await withCleanup(async () => {
    await execute([...compose, 'up', '-d']);
    if (scenario === 'stopped')
      await execute([...compose, 'stop', '--timeout', '5']);
    if (scenario === 'missing-source')
      rmSync('src/apps/user', { recursive: true });
    assert.equal(
      await operateEnvironment('down', 'development', 'cleanup'),
      0,
      'down must work without application source',
    );
    assert.equal(
      await execute([
        'docker',
        'ps',
        '-aq',
        '--filter',
        `label=com.docker.compose.project=${manifest.project}`,
      ]),
      '',
      'down must remove application containers',
    );
    assert.equal(
      await execute([
        'docker',
        'network',
        'ls',
        '-q',
        '--filter',
        `label=com.docker.compose.project=${manifest.project}`,
      ]),
      '',
      'down must remove the project network',
    );
    assert.equal(
      z
        .object({ status: z.string() })
        .parse(JSON.parse(readFileSync(location.manifestPath, 'utf8'))).status,
      'stopped',
    );
  }, [
    async () => {
      await withCleanup(
        () =>
          removeOwnedContainer({
            name: `${manifest.project}-app-user-1`,
            owner: manifest.owner,
          }),
        [() => execute([...compose, 'down', '--remove-orphans'])],
      );
    },
  ]);
}

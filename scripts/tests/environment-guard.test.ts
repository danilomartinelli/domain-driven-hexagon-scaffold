import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommand } from '../lib/command';
import {
  environmentLocation,
  environmentVariables,
  type EnvironmentManifest,
} from '../../database/environment';
import { selectedApplications } from '../../database/topology';

const root = new URL('../../', import.meta.url).pathname;

const preparationOverrides = {
  RABBITMQ_PORT: '31003',
  RABBITMQ_MANAGEMENT_PORT: '15999',
  GATEWAY_HOST: 'host.docker.internal',
  GATEWAY_PROXY_PORT: '31004',
  GATEWAY_ADMIN_PORT: '31005',
};

async function withReadyManifest(
  services: 'active' | 'absent' | 'retained',
  check: (manifest: EnvironmentManifest) => void,
) {
  const run = `guard-${randomUUID().slice(0, 8)}`;
  const location = environmentLocation('test', run);
  const active = services === 'active';
  const manifest: EnvironmentManifest = {
    environment: 'test',
    run,
    project: location.project,
    owner: randomUUID(),
    status: 'ready',
    apps: active ? ['user'] : [],
    topology: selectedApplications(active ? ['user'] : []),
    applicationPorts: active ? { user: 31001 } : {},
    databases: active
      ? [
          {
            app: 'user',
            prefix: 'USER_DB',
            host: '127.0.0.1',
            port: 31002,
            username: 'fixture',
            password: 'fixture',
            database: `${location.project.replaceAll('-', '_')}_user`,
            runtime: { username: 'user_runtime', password: 'fixture' },
          },
        ]
      : [],
    ...(services !== 'absent' && {
      broker: {
        port: 31003,
        managementPort: 15999,
        username: 'fixture',
        password: 'fixture',
        vhost: location.project,
      },
      gateway: {
        name: `${location.project}-gateway`,
        host: 'host.docker.internal',
        proxyPort: 31004,
        adminPort: 31005,
      },
    }),
  };
  await mkdir(location.directory, { recursive: true });
  try {
    await writeFile(location.manifestPath, JSON.stringify(manifest), {
      mode: 0o600,
    });
    check(manifest);
  } finally {
    await rm(location.directory, { recursive: true, force: true });
  }
}

test.each(['active', 'absent', 'retained'] as const)(
  'test environments accept preparation overrides with %s services',
  async (services) => {
    await withReadyManifest(services, (manifest) => {
      const env = environmentVariables(manifest, preparationOverrides);
      expect(env).toMatchObject(preparationOverrides);
      if (services === 'active') {
        expect(env.RABBITMQ_MANAGEMENT_URL).toBe('http://127.0.0.1:15999');
      } else {
        for (const key of [
          'RABBITMQ_HOST',
          'RABBITMQ_USERNAME',
          'RABBITMQ_PASSWORD',
          'RABBITMQ_MANAGEMENT_URL',
          'USER_RABBITMQ_URL',
          'GATEWAY_NAME',
        ])
          expect(env[key], key).toBeUndefined();
      }
    });
  },
);

test.each(['active', 'retained'] as const)(
  'test environments reject preparation overrides conflicting with %s resources',
  async (services) => {
    await withReadyManifest(services, (manifest) => {
      for (const key of Object.keys(preparationOverrides)) {
        expect(() =>
          environmentVariables(manifest, {
            [key]: key === 'GATEWAY_HOST' ? 'foreign.invalid' : '16000',
          }),
        ).toThrow(`${key} differs from the owned run`);
      }
    });
  },
);

test.each(['active', 'absent', 'retained'] as const)(
  'preparation overrides do not authorize foreign targets with %s services',
  async (services) => {
    await withReadyManifest(services, (manifest) => {
      for (const key of [
        'RABBITMQ_MANAGEMENT_URI',
        'OTHER_RABBITMQ_URL',
        'GATEWAY_URL',
      ]) {
        expect(() =>
          environmentVariables(manifest, {
            ...preparationOverrides,
            [key]: 'foreign.invalid',
          }),
        ).toThrow(
          `unregistered ${key.startsWith('GATEWAY_') ? 'gateway' : 'broker'} target: ${key}`,
        );
      }
      if (services !== 'active') {
        for (const key of [
          'RABBITMQ_HOST',
          'RABBITMQ_USERNAME',
          'RABBITMQ_PASSWORD',
          'RABBITMQ_MANAGEMENT_URL',
          'GATEWAY_NAME',
        ]) {
          expect(() =>
            environmentVariables(manifest, { [key]: 'foreign' }),
          ).toThrow('unregistered');
        }
      }
    });
  },
);

test('direct test cleanup and database tools reject an unowned target before connecting', async () => {
  for (const command of [
    ['test', '--preload', './tests/setup/preload.ts', './tests/user'],
    [
      'test',
      '--preload',
      './src/apps/wallet/tests/component/preload.ts',
      './src/apps/wallet/tests/component',
    ],
    [
      'test',
      '--preload',
      './src/apps/user/tests/component/preload.ts',
      './src/apps/user/tests/component',
    ],
    ['database/migrate.mjs', 'down'],
    ['database/seed.mjs'],
  ]) {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      NODE_ENV: 'test',
      DB_NAME: 'ddh_tests',
      DB_HOST: 'unreachable.invalid',
    };
    delete env.DDH_ENVIRONMENT_FILE;
    const result = await runCommand([process.execPath, ...command], {
      cwd: root,
      env,
    });
    expect(result.code).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(
      'Refusing test target without an owned environment',
    );
  }
});

test('the test-database wrapper parses application selections before provisioning anything', async () => {
  for (const [args, message] of [
    [['--app=unknown', '--', 'true'], 'Unknown application: unknown'],
    [
      ['--app=user', '--app=unknown', '--', 'true'],
      'Unknown application: unknown',
    ],
    [['--app=wallet'], 'A command after -- is required.'],
  ] as const) {
    // A parser that never consumes its options would hang here, not fail.
    const result = await runCommand(
      [process.execPath, 'scripts/with-test-database.ts', ...args],
      { cwd: root, timeout: 5_000 },
    );
    expect(result.code, args.join(' ')).toBe(1);
    expect(result.stdout + result.stderr).toContain(message);
  }
}, 30_000);

test('Bun entry points preserve shell settings without automatically importing development files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'starter-env-'));
  try {
    await writeFile(
      join(directory, 'bunfig.toml'),
      await readFile(join(root, 'bunfig.toml')),
    );
    await writeFile(
      join(directory, '.env'),
      'FILE_ONLY=development\nDB_NAME=development\n',
    );
    await writeFile(
      join(directory, '.env.test'),
      'FILE_ONLY=test-file\nDB_NAME=test-file\n',
    );
    const result = await runCommand(
      [
        process.execPath,
        '-e',
        "if (process.env.FILE_ONLY || process.env.DB_NAME !== 'shell') process.exit(1);",
      ],
      {
        cwd: directory,
        env: { ...process.env, NODE_ENV: 'test', DB_NAME: 'shell' },
      },
    );
    expect(result.code, result.stdout + result.stderr).toBe(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

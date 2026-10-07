import { expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { runCommand } from '../lib/command';
import { backupApplication } from '../lib/operations-backup';
import { operationsDiagnostics } from '../lib/operations-diagnostics';
import {
  retainResources,
  type InstallationState,
} from '../lib/operations-config';
import { operationsCompose } from '../lib/operations-compose';
import { deploymentPlan } from '../lib/operations-plan';
import { until } from './app-runtime-fixture';
import { withCleanup } from './cleanup';

const userImage = `example/user@sha256:${'a'.repeat(64)}`;
const userDeployment = { name: 'example', images: { user: userImage } };

function secretState(directory: string): InstallationState {
  return {
    version: 2,
    name: 'example',
    project: 'owned',
    owner: 'owner',
    directory,
    applied: {
      applications: [
        {
          image: userImage,
          declaration: {
            name: 'user',
            persistence: true,
            messaging: true,
            exposure: false,
          },
        },
      ],
    },
    retained: { databases: [] },
  };
}

for (const key of [
  'user-admin-password',
  'user-owner-password',
  'user-runtime-password',
  'broker-password',
]) {
  test(`Compose refuses ambiguous password file contents for ${key}`, () => {
    const directory = mkdtempSync(join(tmpdir(), 'ddh-operations-'));
    try {
      mkdirSync(join(directory, 'secrets'));
      for (const name of [
        'user-admin-password',
        'user-owner-password',
        'user-runtime-password',
        'broker-password',
      ])
        writeFileSync(join(directory, 'secrets', name), 'fixture-password\n');
      for (const value of [
        'fixture-password\r\n',
        'fixture-password\n\n',
        'fixture\rpassword',
        '',
        '\n',
        'fixture\0password',
        Buffer.from([0xc3, 0x28]),
      ]) {
        writeFileSync(join(directory, 'secrets', key), value);
        expect(() => operationsCompose(secretState(directory))).toThrow(
          `Invalid password file: ${key}`,
        );
      }
      for (const value of [
        'fixture-password',
        'fixture-password\n',
        'space /$ unicode é password\n',
        'first\nsecond\n',
      ]) {
        writeFileSync(join(directory, 'secrets', key), value);
        expect(() => operationsCompose(secretState(directory))).not.toThrow();
      }
      writeFileSync(join(directory, 'secrets', key), 'fixture-password\r\n');
      expect(() =>
        operationsCompose(secretState(directory), false),
      ).not.toThrow();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

test('prepare refuses an application argument before contacting Docker or changing inventory', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ddh-prepare-scope-'));
  try {
    writeFileSync(
      join(directory, 'deployment.json'),
      JSON.stringify(userDeployment),
    );
    const marker = join(directory, 'docker-contacted');
    writeFileSync(
      join(directory, 'docker'),
      `#!/usr/bin/env bun\nawait Bun.write(${JSON.stringify(marker)}, 'contacted');\nprocess.exit(91);\n`,
      { mode: 0o700 },
    );
    const result = await runCommand(
      [
        'bun',
        '--no-env-file',
        'scripts/operations.ts',
        `--directory=${directory}`,
        'prepare',
        'user',
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, PATH: `${directory}:${process.env.PATH ?? ''}` },
      },
    );
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(
      'prepare applies to the complete installation; omit the application argument',
    );
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(join(directory, 'state.json'))).toBe(false);
    expect(existsSync(join(directory, 'compose.json'))).toBe(false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('SIGHUP during image creation waits for owned cleanup and releases the operation lock', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ddh-operations-hangup-'));
  const marker = join(directory, 'child.pid');
  writeFileSync(
    join(directory, 'deployment.json'),
    JSON.stringify(userDeployment),
  );
  writeFileSync(
    join(directory, 'docker'),
    `#!/usr/bin/env bun
if (process.argv[2] === 'create') {
  await Bun.write(${JSON.stringify(marker)}, String(process.pid));
  await Bun.sleep(500);
  console.log('owned-preflight-id');
} else if (process.argv[2] === 'ps') console.log('owned-preflight-id');
else if (process.argv[2] === 'rm') await Bun.write(${JSON.stringify(join(directory, 'removed'))}, 'removed');
else if (process.argv[2] === 'start') await Bun.write(${JSON.stringify(join(directory, 'started'))}, 'started');
`,
    { mode: 0o700 },
  );
  const child = Bun.spawn(
    [
      'bun',
      '--no-env-file',
      'scripts/operations.ts',
      `--directory=${directory}`,
      'prepare',
    ],
    {
      env: { ...process.env, PATH: `${directory}:${process.env.PATH ?? ''}` },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const output = Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  await withCleanup(async () => {
    await until(() => Promise.resolve(existsSync(marker)));
    child.kill('SIGHUP');
    expect(await child.exited).toBe(129);
    expect(existsSync(join(directory, '.operation-lock'))).toBe(false);
    expect(existsSync(join(directory, 'removed'))).toBe(true);
    expect(existsSync(join(directory, 'started'))).toBe(false);
    expect(() =>
      process.kill(Number(readFileSync(marker, 'utf8')), 0),
    ).toThrow();
  }, [
    async () => {
      if (child.exitCode === null) child.kill('SIGTERM');
      await child.exited;
      if (existsSync(marker)) {
        try {
          process.kill(-Number(readFileSync(marker, 'utf8')), 'SIGKILL');
        } catch (error) {
          if (!(
            error instanceof Error &&
            'code' in error &&
            error.code === 'ESRCH'
          ))
            throw error;
        }
      }
      await output;
    },
    () => {
      rmSync(directory, { recursive: true, force: true });
    },
  ]);
}, 15_000);

test('operators must select independent immutable image digests before provisioning', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ddh-operations-'));
  try {
    writeFileSync(
      join(directory, 'deployment.json'),
      JSON.stringify({
        name: 'example',
        images: { user: 'example/user:latest' },
      }),
    );
    const result = await runCommand(
      [
        'bun',
        '--no-env-file',
        'scripts/operations.ts',
        `--directory=${directory}`,
        'prepare',
      ],
      { cwd: process.cwd() },
    );
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('digest');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('backup preserves the operation failure and a failed temporary archive cleanup', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ddh-operations-'));
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
    name: 'example',
    project: 'owned',
    owner: 'owner',
    directory,
    applied: { applications: [app] },
    retained: { databases: [] },
  };
  const primary = new Error('pg_dump failed');
  const cleanup = new Error('archive cleanup failed');
  try {
    const result = await backupApplication(
      state,
      app,
      join(directory, 'backup.dump'),
      (args) => {
        if (args.includes('rm')) return Promise.reject(cleanup);
        return Promise.reject(primary);
      },
    ).catch((error: unknown) => error);
    expect(result).toBeInstanceOf(AggregateError);
    if (!(result instanceof AggregateError))
      throw new Error('Expected both failures');
    expect(result.errors).toEqual([primary, cleanup]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('operator diagnostics retain failure causes and statuses while redacting supplied secrets', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ddh-operations-'));
  try {
    mkdirSync(join(directory, 'secrets'));
    writeFileSync(
      join(directory, 'secrets/user-owner-password'),
      'a secret/+value\n',
    );
    const diagnostics = operationsDiagnostics(directory, 'update');
    diagnostics.record(
      {
        code: 143,
        timedOut: false,
        stdout: 'division by zero',
        stderr:
          'a secret/+value a%20secret%2F%2Bvalue postgres://somebody:unknown@database',
      },
      false,
    );
    diagnostics.finish(143);
    const log = readFileSync(diagnostics.logPath, 'utf8');
    expect(log).toContain('division by zero');
    expect(log).not.toContain('a secret');
    expect(log).not.toContain('a%20secret');
    expect(log).not.toContain('unknown');
    expect(statSync(diagnostics.logPath).mode & 0o777).toBe(0o600);
    expect(
      JSON.parse(
        readFileSync(join(diagnostics.logPath, '..', 'result.json'), 'utf8'),
      ),
    ).toMatchObject({ code: 143, commands: [{ code: 143, cleanup: false }] });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

const digest = (repository: string, fill: string) =>
  `example/${repository}@sha256:${fill.repeat(64)}`;
const declaration = (
  name: string,
  capabilities: { persistence: boolean; messaging: boolean; exposure: boolean },
) => ({
  name,
  ...capabilities,
  ...(capabilities.exposure
    ? { routes: [{ name: 'rest', paths: [`/${name}`], stripPath: false }] }
    : {}),
});
const everything = { persistence: true, messaging: true, exposure: true };

function installation(
  applications: InstallationState['applied']['applications'],
  retainedApplications = applications,
): InstallationState {
  const identity = {
    project: 'ddh-ops-example-12345678',
    retained: { databases: [] },
  };
  return {
    version: 2,
    name: 'example',
    owner: 'owner',
    directory: '/installation',
    applied: { https: { bind: '127.0.0.1', port: 8443 }, applications },
    ...identity,
    retained: retainResources(identity, retainedApplications),
  };
}

test('plans desired additions, removals and image changes against applied outcomes and retained resources', () => {
  const migration = {
    operation: 'migrate' as const,
    image: digest('user', 'a'),
    result: 'committed' as const,
    at: '2026-10-06T10:00:00.000Z',
  };
  const startup = {
    operation: 'start' as const,
    image: digest('user', 'a'),
    readiness: 'http' as const,
    result: 'verified' as const,
    at: '2026-10-06T10:01:00.000Z',
  };
  const state = installation([
    {
      image: digest('user', 'a'),
      declaration: declaration('user', everything),
      migration,
      startup,
    },
    {
      image: digest('wallet', 'b'),
      declaration: declaration('wallet', everything),
    },
  ]);
  const plan = deploymentPlan({
    state,
    existing: true,
    desired: {
      https: { bind: '127.0.0.1', port: 8443 },
      applications: [
        {
          image: digest('user', 'c'),
          declaration: declaration('user', everything),
          migrations: ['001_base', '002_marker'],
        },
        {
          image: digest('ledger', 'd'),
          declaration: declaration('ledger', {
            persistence: true,
            messaging: true,
            exposure: false,
          }),
          migrations: ['001_ledger'],
        },
      ],
    },
    histories: { user: ['001_base'] },
    secretFiles: [
      'user-admin-password',
      'user-owner-password',
      'user-runtime-password',
      'broker-password',
      'tls.crt',
      'tls.key',
    ],
  });
  expect(plan.installation).toEqual({
    name: 'example',
    project: 'ddh-ops-example-12345678',
    status: 'existing',
  });
  expect(plan.changed).toBe(true);
  expect(
    plan.applied.applications.map(
      ({ application, image, migration, startup }) => ({
        application,
        image,
        migration,
        startup,
      }),
    ),
  ).toEqual([
    { application: 'user', image: digest('user', 'a'), migration, startup },
    {
      application: 'wallet',
      image: digest('wallet', 'b'),
      migration: 'unrecorded',
      startup: 'unrecorded',
    },
  ]);
  expect(plan.changes).toEqual({
    additions: [
      {
        application: 'ledger',
        image: digest('ledger', 'd'),
        persistence: true,
        messaging: true,
        exposure: false,
        routes: [],
      },
    ],
    removals: [{ application: 'wallet', image: digest('wallet', 'b') }],
    images: [
      {
        application: 'user',
        from: digest('user', 'a'),
        to: digest('user', 'c'),
      },
    ],
    capabilities: [],
    ingress: null,
  });
  expect(plan.services).toEqual({
    add: ['app-ledger', 'postgres-ledger'],
    stop: ['app-wallet', 'postgres-wallet'],
    recreate: ['app-user', 'gateway'],
    unchanged: ['postgres-user', 'rabbitmq'],
  });
  expect(plan.resources).toEqual({
    retain: [
      {
        kind: 'database',
        application: 'user',
        volume: 'ddh-ops-example-12345678_postgres-user',
        before: 'active',
        after: 'active',
      },
      {
        kind: 'database',
        application: 'wallet',
        volume: 'ddh-ops-example-12345678_postgres-wallet',
        before: 'active',
        after: 'inactive',
      },
      {
        kind: 'broker',
        volume: 'ddh-ops-example-12345678_rabbitmq',
        before: 'active',
        after: 'active',
      },
    ],
    provision: [
      {
        kind: 'database',
        application: 'ledger',
        volume: 'ddh-ops-example-12345678_postgres-ledger',
        database: 'ledger',
        roles: ['ledger_owner', 'ledger_runtime'],
        secrets: [
          'ledger-admin-password',
          'ledger-owner-password',
          'ledger-runtime-password',
        ],
      },
    ],
    missingSecrets: [
      'ledger-admin-password',
      'ledger-owner-password',
      'ledger-runtime-password',
    ],
  });
  expect(plan.migrations).toEqual([
    {
      application: 'ledger',
      image: digest('ledger', 'd'),
      history: 'new-database',
      applicable: ['001_ledger'],
      unknownToImage: [],
    },
    {
      application: 'user',
      image: digest('user', 'c'),
      history: 'read',
      applicable: ['002_marker'],
      unknownToImage: [],
    },
  ]);
  expect(plan.interruptions.map((entry) => entry.service)).toEqual([
    'app-user',
    'app-wallet',
    'gateway',
    'postgres-wallet',
  ]);
});

test('plans reactivation of retained inactive resources and capability changes without inventing history', () => {
  const user = {
    image: digest('user', 'a'),
    declaration: declaration('user', everything),
  };
  const wallet = {
    image: digest('wallet', 'b'),
    declaration: declaration('wallet', everything),
  };
  const plan = deploymentPlan({
    state: installation([user], [user, wallet]),
    existing: true,
    desired: {
      applications: [
        {
          image: user.image,
          declaration: declaration('user', {
            persistence: true,
            messaging: true,
            exposure: false,
          }),
          migrations: ['001_base'],
        },
        {
          image: digest('wallet', 'e'),
          declaration: declaration('wallet', {
            persistence: true,
            messaging: true,
            exposure: false,
          }),
          migrations: ['001_wallet'],
        },
      ],
    },
    histories: { user: ['001_base', '000_removed'] },
    secretFiles: [],
  });
  expect(plan.changes.additions.map((entry) => entry.application)).toEqual([
    'wallet',
  ]);
  expect(plan.changes.capabilities).toEqual([
    {
      application: 'user',
      from: {
        persistence: true,
        messaging: true,
        exposure: true,
        routes: ['rest'],
      },
      to: { persistence: true, messaging: true, exposure: false, routes: [] },
    },
  ]);
  expect(plan.changes.ingress).toEqual({
    from: { bind: '127.0.0.1', port: 8443 },
    to: null,
  });
  expect(plan.services).toEqual({
    add: ['app-wallet', 'postgres-wallet'],
    stop: ['gateway'],
    recreate: ['app-user'],
    unchanged: ['postgres-user', 'rabbitmq'],
  });
  expect(plan.resources.provision).toEqual([]);
  expect(plan.resources.retain).toContainEqual({
    kind: 'database',
    application: 'wallet',
    volume: 'ddh-ops-example-12345678_postgres-wallet',
    before: 'inactive',
    after: 'active',
  });
  expect(plan.migrations).toEqual([
    {
      application: 'user',
      image: user.image,
      history: 'read',
      applicable: [],
      unknownToImage: ['000_removed'],
    },
    {
      application: 'wallet',
      image: digest('wallet', 'e'),
      history: 'unavailable',
      applicable: null,
      unknownToImage: null,
    },
  ]);
  expect(plan.interruptions.map((entry) => entry.service)).toEqual([
    'app-user',
    'gateway',
  ]);
});

for (const exposure of [true, false]) {
  test(`an image-only update plans the active gateway interruption (application exposed: ${String(exposure)})`, () => {
    const user = {
      image: digest('user', 'a'),
      declaration: declaration('user', { ...everything, exposure }),
    };
    const wallet = {
      image: digest('wallet', 'b'),
      declaration: declaration('wallet', everything),
    };
    const state = installation([user, wallet]);
    const plan = deploymentPlan({
      state,
      existing: true,
      desired: {
        https: state.applied.https,
        applications: [
          { ...user, image: digest('user', 'c'), migrations: [] },
          { ...wallet, migrations: [] },
        ],
      },
      histories: { user: [], wallet: [] },
      secretFiles: [],
    });
    expect(plan.changes.capabilities).toEqual([]);
    expect(plan.changes.ingress).toBeNull();
    expect(plan.services).toEqual({
      add: [],
      stop: [],
      recreate: ['app-user', 'gateway'],
      unchanged: ['app-wallet', 'postgres-user', 'postgres-wallet', 'rabbitmq'],
    });
    expect(plan.interruptions).toContainEqual({
      service: 'gateway',
      effect: 'Recreated; every exposed route is briefly unavailable',
    });
  });
}

test('an image-only update without exposed applications does not plan a gateway', () => {
  const user = {
    image: digest('user', 'a'),
    declaration: declaration('user', { ...everything, exposure: false }),
  };
  const state = installation([user]);
  const plan = deploymentPlan({
    state,
    existing: true,
    desired: {
      https: state.applied.https,
      applications: [{ ...user, image: digest('user', 'c'), migrations: [] }],
    },
    histories: { user: [] },
    secretFiles: [],
  });
  expect(plan.services).toEqual({
    add: [],
    stop: [],
    recreate: ['app-user'],
    unchanged: ['postgres-user', 'rabbitmq'],
  });
  expect(plan.interruptions.map(({ service }) => service)).toEqual([
    'app-user',
  ]);
});

test('an unchanged desired selection plans no service change but reports pending owned migrations', () => {
  const user = {
    image: digest('user', 'a'),
    declaration: declaration('user', everything),
  };
  const plan = deploymentPlan({
    state: installation([user]),
    existing: true,
    desired: {
      https: { bind: '127.0.0.1', port: 8443 },
      applications: [{ ...user, migrations: ['001_base'] }],
    },
    histories: { user: [] },
    secretFiles: [],
  });
  expect(plan.changed).toBe(false);
  expect(plan.services).toEqual({
    add: [],
    stop: [],
    recreate: [],
    unchanged: ['app-user', 'gateway', 'postgres-user', 'rabbitmq'],
  });
  expect(plan.interruptions).toEqual([]);
  expect(plan.migrations[0]?.applicable).toEqual(['001_base']);
});

/** Run the public operator command against a recording Docker stand-in. */
function fakeDockerOperations(directory: string) {
  const log = join(directory, 'docker.log');
  writeFileSync(
    join(directory, 'docker'),
    `#!/usr/bin/env bun\nimport { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');\n`,
    { mode: 0o700 },
  );
  return {
    ops: (...args: string[]) =>
      runCommand(
        [
          'bun',
          '--no-env-file',
          'scripts/operations.ts',
          `--directory=${directory}`,
          ...args,
        ],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            PATH: `${directory}:${process.env.PATH ?? ''}`,
          },
        },
      ),
    calls: (): string[][] =>
      existsSync(log)
        ? readFileSync(log, 'utf8')
            .trim()
            .split('\n')
            .map((line) => z.array(z.string()).parse(JSON.parse(line)))
        : [],
    json: (file: string): unknown =>
      JSON.parse(readFileSync(join(directory, file), 'utf8')),
  };
}

test('shutdown adopts a version 1 inventory with its original identities and desired selection', async () => {
  const directory = realpathSync(
    mkdtempSync(join(tmpdir(), 'ddh-operations-adoption-')),
  );
  try {
    const updated = `example/user@sha256:${'b'.repeat(64)}`;
    const bootstrap = {
      ...userDeployment,
      https: { bind: '127.0.0.1', port: 8443 },
    };
    const desired = JSON.stringify(bootstrap);
    writeFileSync(join(directory, 'deployment.json'), desired);
    writeFileSync(
      join(directory, 'state.json'),
      JSON.stringify({
        version: 1,
        project: 'owned',
        owner: 'owner',
        directory,
        config: bootstrap,
        artifacts: [
          {
            image: updated,
            declaration: {
              name: 'user',
              persistence: true,
              messaging: true,
              exposure: false,
            },
          },
        ],
      }),
    );
    const docker = fakeDockerOperations(directory);
    const result = await docker.ops('down');
    expect(result.code, result.stderr).toBe(0);
    expect(docker.json('state.json')).toEqual({
      version: 2,
      name: 'example',
      project: 'owned',
      owner: 'owner',
      directory,
      applied: {
        https: { bind: '127.0.0.1', port: 8443 },
        applications: [
          {
            image: updated,
            declaration: {
              name: 'user',
              persistence: true,
              messaging: true,
              exposure: false,
            },
          },
        ],
      },
      retained: {
        databases: [
          {
            application: 'user',
            service: 'postgres-user',
            volume: 'owned_postgres-user',
            database: 'user',
            roles: ['user_owner', 'user_runtime'],
            secrets: [
              'user-admin-password',
              'user-owner-password',
              'user-runtime-password',
            ],
          },
        ],
        broker: {
          service: 'rabbitmq',
          volume: 'owned_rabbitmq',
          vhost: 'owned',
          username: 'scaffold',
          secrets: ['broker-password'],
        },
      },
    });
    // The bootstrap file stays desired; plan reports its difference from the update.
    expect(readFileSync(join(directory, 'deployment.json'), 'utf8')).toBe(
      desired,
    );
    expect(result.stderr).toContain('deployment.json are unchanged');
    expect(docker.calls()).toContainEqual([
      'compose',
      '--project-name',
      'owned',
      '--file',
      join(directory, 'compose.json'),
      '--profile',
      'applications',
      '--profile',
      'commands',
      'down',
      '--timeout',
      '20',
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('inspection and shutdown use applied inventory while planning and image updates explain unusable desired selections', async () => {
  const directory = realpathSync(
    mkdtempSync(join(tmpdir(), 'ddh-operations-desired-')),
  );
  try {
    const state = secretState(directory);
    writeFileSync(join(directory, 'state.json'), JSON.stringify(state));
    const docker = fakeDockerOperations(directory);
    const candidate = `example/user@sha256:${'c'.repeat(64)}`;
    for (const [desired, explanation, planned] of [
      ['{', 'deployment.json is not valid JSON', true],
      [
        JSON.stringify({
          name: 'example',
          images: { user: 'example/user:latest' },
        }),
        'Select an exact repository@sha256 image digest',
        true,
      ],
      [
        JSON.stringify({ ...userDeployment, name: 'renamed' }),
        'the name is part of the recorded identity',
        true,
      ],
      [
        JSON.stringify({
          name: 'example',
          images: { wallet: `example/wallet@sha256:${'d'.repeat(64)}` },
        }),
        'user is absent from the desired selection',
        false,
      ],
    ] as const) {
      writeFileSync(join(directory, 'deployment.json'), desired);
      for (const args of [
        ...(planned ? [['plan']] : []),
        ['update', 'user', `--image=${candidate}`],
        ['rollback', 'user', `--image=${candidate}`],
      ]) {
        const refused = await docker.ops(...args);
        expect(refused.code).not.toBe(0);
        expect(refused.stderr).toContain(explanation);
      }
      expect(docker.calls()).toEqual([]);
      expect(docker.json('state.json')).toEqual(state);
      expect(readFileSync(join(directory, 'deployment.json'), 'utf8')).toBe(
        desired,
      );
      const shutdown = await docker.ops('down');
      expect(shutdown.code, shutdown.stderr).toBe(0);
      expect(docker.calls().at(-1)?.slice(0, 3)).toEqual([
        'compose',
        '--project-name',
        'owned',
      ]);
      expect(
        Object.keys(
          z
            .object({ services: z.record(z.string(), z.unknown()) })
            .parse(docker.json('compose.json')).services,
        ),
      ).toEqual(['postgres-user', 'migrate-user', 'app-user', 'rabbitmq']);
      expect(docker.json('state.json')).toEqual(state);
      rmSync(join(directory, 'docker.log'), { force: true });
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

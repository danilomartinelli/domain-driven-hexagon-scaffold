import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import {
  environmentLocation,
  readEnvironment,
} from '../../database/environment';
import { runCommand } from '../lib/command';
import { composeProbeConfiguration } from './compose-fixture';
import { availablePort } from '../lib/environments';
import { withCleanup } from './cleanup';

const root = new URL('../../', import.meta.url).pathname;
const run = `probe-${randomUUID().slice(0, 8)}`;

test.each([
  {
    username: 'runtime',
    password: 'a$ROLE_SCRIPT_PROBE',
    sql: 'CREATE ROLE "runtime" LOGIN PASSWORD \'a$$ROLE_SCRIPT_PROBE\';\n',
  },
  {
    username: 'run"$ROLE_SCRIPT_PROBE',
    password: "a'${ROLE_SCRIPT_PROBE}$$$",
    sql: 'CREATE ROLE "run""$$ROLE_SCRIPT_PROBE" LOGIN PASSWORD \'a\'\'$${ROLE_SCRIPT_PROBE}$$$$$$\';\n',
  },
  {
    username: 'run${ROLE_SCRIPT_MISSING}',
    password: '$ROLE_SCRIPT_MISSING',
    sql: 'CREATE ROLE "run$${ROLE_SCRIPT_MISSING}" LOGIN PASSWORD \'$$ROLE_SCRIPT_MISSING\';\n',
  },
])(
  'Compose preserves dollar signs in runtime role SQL %#',
  async ({ username, password, sql }) => {
    const directory = await mkdtemp(join(tmpdir(), 'starter-compose-'));
    await withCleanup(async () => {
      const configuration = composeProbeConfiguration(username, password);
      const file = join(directory, 'compose.json');
      await writeFile(file, JSON.stringify(configuration), { mode: 0o600 });
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        ROLE_SCRIPT_PROBE: 'interpolated',
      };
      delete env.ROLE_SCRIPT_MISSING;
      const result = await runCommand(
        [
          'docker',
          'compose',
          '--env-file',
          '/dev/null',
          '-p',
          'compose-probe',
          '-f',
          file,
          'config',
          '--format',
          'json',
        ],
        { cwd: directory, env },
      );
      expect(result.code, result.stderr).toBe(0);
      const resolved = z
        .object({
          configs: z.object({
            'wallet-runtime-role': z.object({ content: z.string() }),
          }),
        })
        .parse(JSON.parse(result.stdout));
      // Canonical Compose output re-escapes literal dollars for reuse as input.
      expect(resolved.configs['wallet-runtime-role'].content).toBe(sql);
    }, [() => rm(directory, { recursive: true, force: true })]);
  },
);

function environment(
  command: string,
  args: string[] = [],
  env: NodeJS.ProcessEnv = {},
) {
  return runCommand(
    [
      process.execPath,
      'run',
      `env:${command}`,
      '--environment=test',
      `--run=${run}`,
      ...args,
    ],
    { cwd: root, env: { ...process.env, ...env }, timeout: 120_000 },
  );
}

/** User has a pending event; the direct Wallet lookup fixture has a different identity. */
const seedsProbe = `
  const { Client } = await import('pg');
  // Wallet's runtime role can read its own seeded lookup example.
  const wallets = new Client({host: process.env.WALLET_DB_HOST, port: Number(process.env.WALLET_DB_PORT), user: process.env.WALLET_DB_USERNAME, password: process.env.WALLET_DB_PASSWORD, database: process.env.WALLET_DB_NAME});
  await wallets.connect();
  const lookups = (await wallets.query('SELECT "userId", balance FROM wallets')).rows;
  await wallets.end();
  if (lookups.length !== 1 || lookups[0].userId !== 'f59d0748-d455-4465-b0a8-8d8260b1c877' || lookups[0].balance !== 0) throw new Error('Wallet lookup seed missing');
  const standalone = new Client({host: process.env.USER_DB_HOST, port: Number(process.env.USER_DB_PORT), user: process.env.USER_DB_USERNAME, password: process.env.USER_DB_PASSWORD, database: process.env.USER_DB_NAME});
  await standalone.connect();
  const ownProfiles = (await standalone.query('SELECT id, email FROM users')).rows;
  const pending = (await standalone.query('SELECT envelope FROM user_outbox WHERE published_at IS NULL')).rows;
  await standalone.end();
  if (ownProfiles.length !== 1 || pending.length !== 1 || pending[0].envelope.data.userId !== ownProfiles[0].id) throw new Error('User seed must have exactly one pending creation');
  if (lookups.some((wallet) => wallet.userId === ownProfiles[0].id)) throw new Error('User seed duplicates direct Wallet insertion');
`;

test('a named test environment prepares PostgreSQL and RabbitMQ for explicit database tooling', async () => {
  await withCleanup(async () => {
    const prepared = await environment('prepare');
    expect(prepared.code, prepared.stdout + prepared.stderr).toBe(0);
    for (const app of ['wallet', 'user']) {
      for (const script of ['migration:up:tests', 'seed:up:tests']) {
        const result = await environment(
          'exec',
          ['--', process.execPath, 'run', script],
          { DATABASE_APP: app },
        );
        expect(result.code, result.stdout + result.stderr).toBe(0);
      }
    }
    const probe = await environment('exec', [
      '--',
      process.execPath,
      '-e',
      `
      ${seedsProbe}
      const response = await fetch(process.env.RABBITMQ_MANAGEMENT_URL + '/api/vhosts/' + encodeURIComponent(process.env.RABBITMQ_VHOST), {headers: {Authorization: 'Basic ' + btoa(process.env.RABBITMQ_USERNAME + ':' + process.env.RABBITMQ_PASSWORD)}});
      if (!response.ok) throw new Error('Owned broker namespace unavailable: ' + response.status);
      console.log('prepared resources verified');
    `,
    ]);
    expect(probe.code, probe.stdout + probe.stderr).toBe(0);
    expect(probe.stdout).toContain('prepared resources verified');
  }, [() => succeeded(environment('down'))]);
}, 180_000);

function namedEnvironment(kind: 'test' | 'development', name: string) {
  return (command: string, args: string[] = [], env: NodeJS.ProcessEnv = {}) =>
    runCommand(
      [
        process.execPath,
        'run',
        `env:${command}`,
        `--environment=${kind}`,
        `--run=${name}`,
        ...args,
      ],
      { cwd: root, env: { ...process.env, ...env }, timeout: 120_000 },
    );
}

test('development exec survives command deadlines while test exec stays bounded', async () => {
  const name = `deadline-${randomUUID().slice(0, 8)}`;
  const dev = namedEnvironment('development', name);
  const regression = namedEnvironment('test', name);
  await withCleanup(async () => {
    await succeeded(dev('prepare'));
    await succeeded(regression('prepare'));
    const execute = (kind: 'development' | 'test') =>
      runCommand(
        [
          process.execPath,
          '--no-env-file',
          '--preload',
          './scripts/tests/fixtures/fast-command-deadline.ts',
          'scripts/environment-cli.ts',
          '--nx',
          'exec',
          `--environment=${kind}`,
          `--run=${name}`,
          '--',
          process.execPath,
          '-e',
          "await Bun.sleep(400); console.log('COMMAND_SURVIVED');",
        ],
        { cwd: root, timeout: 10_000 },
      );
    const development = await execute('development');
    expect(development.code, development.stdout + development.stderr).toBe(0);
    expect(development.stdout).toContain('\nCOMMAND_SURVIVED\n');
    const testRun = await execute('test');
    expect(testRun.code, testRun.stdout + testRun.stderr).toBe(124);
    expect(testRun.timedOut).toBe(false);
    expect(testRun.stdout).not.toContain('\nCOMMAND_SURVIVED\n');
  }, [() => succeeded(dev('down')), () => succeeded(regression('down'))]);
}, 180_000);

const seedProbe = `
  const {Client} = await import('pg');
  const client = new Client({host: process.env.USER_DB_HOST, port: Number(process.env.USER_DB_PORT), user: process.env.USER_DB_USERNAME, password: process.env.USER_DB_PASSWORD, database: process.env.USER_DB_NAME});
  await client.connect();
  const {rows} = await client.query('SELECT email FROM users ORDER BY email');
  if (rows.length !== 1 || rows[0].email !== 'john@gmail.com') throw new Error('Seed was modified');
  await client.end();
  console.log('seed intact');
`;

function brokerQueue(method: 'GET' | 'PUT') {
  return `
    const response = await fetch(process.env.RABBITMQ_MANAGEMENT_URL + '/api/queues/' + encodeURIComponent(process.env.RABBITMQ_VHOST) + '/preservation', {
      method: '${method}', headers: {'Content-Type': 'application/json', Authorization: 'Basic ' + btoa(process.env.RABBITMQ_USERNAME + ':' + process.env.RABBITMQ_PASSWORD)},
      ${method === 'PUT' ? 'body: JSON.stringify({durable: true, auto_delete: false, arguments: {}}),' : ''}
    });
    if (!response.ok) throw new Error('Development broker data missing: ' + response.status);
  `;
}

async function succeeded(
  result: ReturnType<ReturnType<typeof namedEnvironment>>,
) {
  const value = await result;
  expect(value.code, value.stdout + value.stderr).toBe(0);
  return value;
}

test('prepared regression runs reject foreign targets and preserve development and sibling data', async () => {
  const id = randomUUID().slice(0, 8);
  const dev = namedEnvironment('development', `dev-${id}`);
  const first = namedEnvironment('test', `first-${id}`);
  const sibling = namedEnvironment('test', `sibling-${id}`);
  const environments = [dev, first, sibling];
  await withCleanup(
    async () => {
      const prepared = await Promise.allSettled(
        environments.map((cli) => succeeded(cli('prepare'))),
      );
      for (const result of prepared)
        if (result.status === 'rejected') throw result.reason;
      for (const cli of environments) {
        for (const app of ['user', 'wallet']) {
          for (const script of ['migration:up', 'seed:up'])
            await succeeded(
              cli('exec', ['--', process.execPath, 'run', script], {
                DATABASE_APP: app,
              }),
            );
        }
      }
      await succeeded(
        dev('exec', ['--', process.execPath, '-e', brokerQueue('PUT')]),
      );
      const infoCode = `console.log('TARGET=' + JSON.stringify({database: process.env.USER_DB_NAME, port: process.env.USER_DB_PORT, vhost: process.env.RABBITMQ_VHOST, brokerPort: process.env.RABBITMQ_PORT}));`;
      const firstInfo = await succeeded(
        first('exec', ['--', process.execPath, '-e', infoCode]),
      );
      const siblingInfo = await succeeded(
        sibling('exec', ['--', process.execPath, '-e', infoCode]),
      );
      const parseInfo = (output: string) =>
        z
          .object({
            database: z.string(),
            port: z.string(),
            vhost: z.string(),
            brokerPort: z.string(),
          })
          .parse(JSON.parse(/^TARGET=(.+)$/m.exec(output)?.[1] ?? 'null'));
      const firstTarget = parseInfo(firstInfo.stdout);
      const siblingTarget = parseInfo(siblingInfo.stdout);
      expect(firstTarget.database).not.toBe(siblingTarget.database);
      expect(firstTarget.port).not.toBe(siblingTarget.port);
      expect(firstTarget.vhost).not.toBe(siblingTarget.vhost);
      expect(firstTarget.brokerPort).not.toBe(siblingTarget.brokerPort);
      const marker = [
        '--',
        process.execPath,
        '-e',
        "console.log('UNSAFE_COMMAND_STARTED')",
      ];
      for (const override of [
        { DB_NAME: siblingTarget.database },
        { DB_NAME: 'ddh_tests' },
        { DB_PORT: siblingTarget.port },
        { DB_HOST: 'localhost' },
        { DB_USERNAME: 'another' },
        { DB_PASSWORD: 'another' },
        { USER_DB_NAME: siblingTarget.database },
        { WALLET_DB_NAME: siblingTarget.database },
        { WALLET_DB_MIGRATION_PASSWORD: 'another' },
        { WALLET_DB_MIGRATION_HOST: 'localhost' },
        { DATABASE_URL: 'postgres://localhost/development' },
        { RABBITMQ_VHOST: siblingTarget.vhost },
      ]) {
        const rejected = await first('exec', marker, override);
        expect(rejected.code, rejected.stdout + rejected.stderr).not.toBe(0);
        expect(rejected.stdout).toContain('Refusing');
        expect(rejected.stdout).not.toContain('\nUNSAFE_COMMAND_STARTED\n');
      }
      const shell = await succeeded(
        first(
          'exec',
          [
            '--',
            process.execPath,
            '-e',
            "if (process.env.ISSUE18_SETTING !== 'shell') throw new Error('shell override lost');",
          ],
          { ISSUE18_SETTING: 'shell' },
        ),
      );
      expect(shell.code).toBe(0);
      // Agent mode (such as CLAUDECODE=1) omits the per-file headers checked
      // below; on Bun 1.4.2, AGENT=0 takes precedence over agent detection.
      // https://bun.com/docs/test#ai-agent-integration
      const regression = await succeeded(
        first('exec', ['--', process.execPath, 'run', 'test:e2e:prepared'], {
          AGENT: '0',
        }),
      );
      // The regression suite grows; require both Gherkin and database coverage.
      const output = Bun.stripANSI(regression.stderr + regression.stdout);
      for (const file of [
        'tests/user/create-user/create-user.test.ts',
        'tests/user/delete-user/delete-user.test.ts',
        'tests/integration/find-users.test.ts',
        'tests/integration/user-wallet.test.ts',
        'tests/integration/user-api-contract.test.ts',
      ]) {
        expect(output).toContain(`\n${file}:\n`);
      }
      expect(output).toMatch(/^\s*0 fail\s*$/m);
      const passed = /(\d+) pass/.exec(output);
      expect(Number(passed?.[1] ?? 0)).toBeGreaterThanOrEqual(7);
      await succeeded(first('down'));
      await succeeded(
        sibling('exec', ['--', process.execPath, '-e', seedProbe]),
      );
      await succeeded(dev('exec', ['--', process.execPath, '-e', seedProbe]));
      // Development volumes remain usable after shutdown and restart.
      await succeeded(dev('down'));
      await succeeded(dev('prepare'));
      await succeeded(
        dev('exec', ['--', process.execPath, '-e', brokerQueue('GET')]),
      );
      await succeeded(dev('exec', ['--', process.execPath, '-e', seedProbe]));
    },
    environments.map((cli) => () => succeeded(cli('down'))),
  );
}, 240_000);

test('a bound database port fails preparation and removes only the failed run', async () => {
  const id = randomUUID().slice(0, 8);
  const sibling = namedEnvironment('test', `holder-${id}`);
  const failed = namedEnvironment('test', `bind-${id}`);
  await withCleanup(async () => {
    await succeeded(sibling('prepare'));
    const info = await succeeded(
      sibling('exec', [
        '--',
        process.execPath,
        '-e',
        "console.log('PORT=' + process.env.USER_DB_PORT)",
      ]),
    );
    const port = /^PORT=(\d+)$/m.exec(info.stdout)?.[1];
    expect(port).toBeDefined();
    const prepared = await failed('prepare', [], { USER_DB_PORT: port });
    expect(prepared.code).not.toBe(0);
    expect(prepared.stdout + prepared.stderr).toMatch(
      /port is already allocated|address already in use/,
    );
    const project = /Test run: (ddh-test-[a-z0-9-]+)/.exec(
      prepared.stdout,
    )?.[1];
    expect(project).toBeDefined();
    const remaining = await runCommand(
      [
        'docker',
        'ps',
        '-aq',
        '--filter',
        `label=com.docker.compose.project=${project ?? 'missing'}`,
      ],
      { cwd: root },
    );
    expect(remaining.code).toBe(0);
    expect(remaining.stdout.trim()).toBe('');
    await succeeded(
      sibling('exec', [
        '--',
        process.execPath,
        '-e',
        "console.log('sibling still available')",
      ]),
    );
  }, [() => succeeded(failed('down')), () => succeeded(sibling('down'))]);
}, 120_000);

test('preparing a development run created before independent apps were registered preserves legacy data', async () => {
  const name = `upgrade-${randomUUID().slice(0, 8)}`;
  const dev = namedEnvironment('development', name);
  const { project, directory, manifestPath } = environmentLocation(
    'development',
    name,
  );
  const legacy = {
    app: 'legacy',
    prefix: 'DB',
    host: '127.0.0.1' as const,
    port: await availablePort(),
    username: 'starter',
    password: randomUUID(),
    database: `${project.replaceAll('-', '_')}_legacy`,
  };
  // The manifest shape written while legacy was the only registered application.
  await mkdir(directory, { recursive: true });
  await writeFile(
    manifestPath,
    JSON.stringify({
      environment: 'development',
      run: name,
      project,
      owner: randomUUID(),
      status: 'stopped',
      databases: [legacy],
      broker: {
        port: await availablePort(),
        managementPort: await availablePort(),
        username: 'starter',
        password: randomUUID(),
        vhost: project,
      },
      gateway: {
        name: `${project}-gateway`,
        host: 'host.docker.internal',
        proxyPort: await availablePort(),
        adminPort: await availablePort(),
        userPort: await availablePort(),
        walletPort: await availablePort(),
      },
    }),
    { mode: 0o600 },
  );
  await withCleanup(async () => {
    const stale = await dev('exec', [
      '--',
      process.execPath,
      '-e',
      "console.log('STALE_COMMAND_STARTED')",
    ]);
    expect(stale.code).not.toBe(0);
    expect(stale.stdout + stale.stderr).toContain('prepare it again');
    expect(stale.stdout).not.toContain('\nSTALE_COMMAND_STARTED\n');

    await succeeded(dev('prepare'));
    const upgraded = readEnvironment('development', name);
    const retiredProbe = `
      const {Client} = await import('pg');
      const db = new Client({host: process.env.DB_HOST, port: Number(process.env.DB_PORT), user: process.env.DB_USERNAME, password: process.env.DB_PASSWORD, database: process.env.DB_NAME});
      await db.connect();
      if (process.env.CREATE_RETIRED_MARKER) await db.query('CREATE TABLE retained_marker (id integer PRIMARY KEY); INSERT INTO retained_marker VALUES (42)');
      const {rows} = await db.query('SELECT id FROM retained_marker');
      if (rows.length !== 1 || rows[0].id !== 42) throw new Error('Retired development data lost');
      await db.end();
    `;
    await succeeded(
      dev('exec', ['--', process.execPath, '-e', retiredProbe], {
        CREATE_RETIRED_MARKER: '1',
      }),
    );
    expect(upgraded.databases.find((db) => db.app === 'legacy')).toEqual(
      legacy,
    );
    expect(upgraded.databases.map((db) => db.app).sort()).toEqual([
      'legacy',
      'user',
      'wallet',
    ]);
    for (const app of ['wallet', 'user']) {
      for (const script of ['migration:up', 'seed:up'])
        await succeeded(
          dev('exec', ['--', process.execPath, 'run', script], {
            DATABASE_APP: app,
          }),
        );
    }
    await succeeded(dev('exec', ['--', process.execPath, '-e', seedsProbe]));
    // Preparing again reuses the upgraded manifest and all databases' data.
    await succeeded(dev('down'));
    await succeeded(dev('prepare'));
    expect(readEnvironment('development', name)).toEqual({
      ...upgraded,
      status: 'ready',
    });
    await succeeded(dev('exec', ['--', process.execPath, '-e', seedsProbe]));
    await succeeded(dev('exec', ['--', process.execPath, '-e', retiredProbe]));
  }, [() => succeeded(dev('down'))]);
}, 180_000);

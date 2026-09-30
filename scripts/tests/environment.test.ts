import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { runCommand } from '../lib/command';
import { withCleanup } from './cleanup';

const root = new URL('../../', import.meta.url).pathname;
const run = `probe-${randomUUID().slice(0, 8)}`;

function environment(command: string, args: string[] = []) {
  return runCommand(
    [
      process.execPath,
      'run',
      `env:${command}`,
      '--environment=test',
      `--run=${run}`,
      ...args,
    ],
    { cwd: root, timeout: 120_000 },
  );
}

test('a named test environment prepares PostgreSQL and RabbitMQ for explicit database tooling', async () => {
  await withCleanup(async () => {
    const prepared = await environment('prepare');
    expect(prepared.code, prepared.stdout + prepared.stderr).toBe(0);
    const migrated = await environment('exec', [
      '--',
      process.execPath,
      'run',
      'migration:up:tests',
    ]);
    expect(migrated.code, migrated.stdout + migrated.stderr).toBe(0);
    const seeded = await environment('exec', [
      '--',
      process.execPath,
      'run',
      'seed:up:tests',
    ]);
    expect(seeded.code, seeded.stdout + seeded.stderr).toBe(0);
    const probe = await environment('exec', [
      '--',
      process.execPath,
      '-e',
      `
      const { Client } = await import('pg');
      const client = new Client({host: process.env.DB_HOST, port: Number(process.env.DB_PORT), user: process.env.DB_USERNAME, password: process.env.DB_PASSWORD, database: process.env.DB_NAME});
      await client.connect();
      const {rows} = await client.query('SELECT email FROM users');
      if (rows.length !== 1 || rows[0].email !== 'john@gmail.com') throw new Error('Selected seed missing');
      await client.end();
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
  const client = new Client({host: process.env.DB_HOST, port: Number(process.env.DB_PORT), user: process.env.DB_USERNAME, password: process.env.DB_PASSWORD, database: process.env.DB_NAME});
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
        await succeeded(
          cli('exec', ['--', process.execPath, 'run', 'migration:up']),
        );
        await succeeded(
          cli('exec', ['--', process.execPath, 'run', 'seed:up']),
        );
      }
      await succeeded(
        dev('exec', ['--', process.execPath, '-e', brokerQueue('PUT')]),
      );
      const infoCode = `console.log('TARGET=' + JSON.stringify({database: process.env.DB_NAME, port: process.env.DB_PORT, vhost: process.env.RABBITMQ_VHOST, brokerPort: process.env.RABBITMQ_PORT}));`;
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
      const regression = await succeeded(
        first('exec', ['--', process.execPath, 'run', 'test:e2e:prepared']),
      );
      // The regression suite grows; require at least the seven original cases.
      const passed = /(\d+) pass/.exec(regression.stderr + regression.stdout);
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
        "console.log('PORT=' + process.env.DB_PORT)",
      ]),
    );
    const port = /^PORT=(\d+)$/m.exec(info.stdout)?.[1];
    expect(port).toBeDefined();
    const prepared = await failed('prepare', [], { DB_PORT: port });
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

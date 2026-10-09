import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { expect, test } from 'bun:test';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { runCommand } from '../lib/command';
import { createWorkspace } from './workspace-fixture';
import { tcpGate } from './tcp-gate';
import { withCleanup } from './cleanup';
import { appWorkspace, generate, run } from './app-generator-fixture';
import { withApp } from './app-runtime-fixture';
import { runDistributionRuntimeProbe } from './distribution-runtime-fixture';

const root = new URL('../../', import.meta.url).pathname;

for (const app of ['user', 'wallet'] as const)
  for (const platform of [undefined, '', 'linux/amd64'])
    test(`distribution fixture ${app} uses a supplied image with ${platform === undefined ? 'absent' : platform || 'empty'} platform`, async () => {
      const result = await runDistributionRuntimeProbe({
        mode: 'selection',
        app,
        platform,
      });
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toContain(
        `Selected image sha256:${'a'.repeat(64)} on ${platform || `linux/${process.arch === 'arm64' ? 'arm64' : 'amd64'}`}`,
      );
      expect(result.stdout).not.toContain('Host package selected');
    });

for (const expectedExit of [0, [0, 1]])
  test(`image shutdown includes application logs for unexpected exit with ${JSON.stringify(expectedExit)}`, async () => {
    const result = await runDistributionRuntimeProbe({
      mode: 'shutdown',
      app: 'user',
      expectedExit,
    });
    expect(result.code, result.stderr).toBe(0);
    const observation = z
      .object({ error: z.string(), removed: z.boolean() })
      .parse(JSON.parse(result.stdout.trim().split('\n').at(-1) ?? ''));
    expect(observation.removed).toBe(true);
    expect(observation.error).toContain('shutdown drain started');
    expect(observation.error).toContain('shutdown deadline exceeded');
    expect(observation.error).toContain('7');
  });

for (const app of ['user', 'wallet'])
  for (const scenario of [
    { name: 'without image selection', selection: {}, calls: 1, code: 0 },
    {
      name: 'with empty image selection',
      selection: { DDH_VALIDATED_IMAGE: '', DDH_IMAGE_PLATFORM: '' },
      calls: 1,
      code: 0,
    },
    {
      name: 'with an approved image',
      selection: { DDH_VALIDATED_IMAGE: 'sha256:fixture' },
      calls: 2,
      code: 0,
    },
    {
      name: 'with an image platform',
      selection: { DDH_IMAGE_PLATFORM: 'linux/arm64' },
      calls: 2,
      code: 0,
    },
    {
      name: 'with an approved platform image',
      selection: {
        DDH_VALIDATED_IMAGE: 'sha256:fixture',
        DDH_IMAGE_PLATFORM: 'linux/arm64',
      },
      calls: 2,
      code: 0,
    },
    {
      name: 'after a distribution failure',
      selection: { DDH_IMAGE_PLATFORM: 'linux/arm64', DISTRIBUTION_EXIT: '37' },
      calls: 1,
      code: 37,
    },
    {
      name: 'after an image shutdown failure',
      selection: { DDH_IMAGE_PLATFORM: 'linux/arm64', SHUTDOWN_EXIT: '42' },
      calls: 2,
      code: 42,
    },
  ])
    test(`distribution target ${app} provisions only selected scenarios ${scenario.name}`, async () => {
      const directory = mkdtempSync(
        join(tmpdir(), 'starter-distribution-target-'),
      );
      try {
        const log = join(directory, 'calls.jsonl');
        writeFileSync(log, '');
        writeFileSync(
          join(directory, 'bun'),
          `#!${process.execPath}
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
process.exit(Number(args.at(-1).includes('shutdown') ? process.env.SHUTDOWN_EXIT : process.env.DISTRIBUTION_EXIT) || 0);
`,
          { mode: 0o700 },
        );
        const project = z
          .object({
            targets: z.object({
              'test-distribution': z.object({
                options: z.object({ command: z.string() }),
              }),
            }),
          })
          .parse(
            JSON.parse(
              readFileSync(join(root, `src/apps/${app}/project.json`), 'utf8'),
            ),
          );
        const result = await runCommand(
          [
            '/bin/sh',
            '-c',
            project.targets['test-distribution'].options.command,
          ],
          {
            cwd: root,
            env: {
              PATH: `${directory}:${process.env.PATH ?? ''}`,
              ...scenario.selection,
            },
          },
        );
        expect(result.code, result.stderr).toBe(scenario.code);
        const calls = readFileSync(log, 'utf8')
          .trim()
          .split('\n')
          .map((line) => z.array(z.string()).parse(JSON.parse(line)));
        expect(calls).toHaveLength(scenario.calls);
        for (const args of calls)
          expect(args.slice(0, 3)).toEqual([
            'scripts/with-test-database.ts',
            `--app=${app}`,
            '--no-database-setup',
          ]);
        expect(calls[0].at(-1)).toBe(
          `./scripts/tests/distribution-${app}.test.ts`,
        );
        if (scenario.calls === 2)
          expect(calls[1].at(-1)).toBe(
            `./scripts/tests/distribution-${app === 'user' ? '' : 'wallet-'}shutdown.test.ts`,
          );
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });

test('disabled prepared integrations retain source but deliver no inactive adapters or migration interface', async () => {
  const workspace = await appWorkspace();
  const delivery = mkdtempSync(join(tmpdir(), 'starter-disabled-'));
  const sentinel = await tcpGate();
  await withCleanup(async () => {
    await run(workspace, generate('telemetry', '--persistence=true'));
    const app = join(workspace.root, 'src/apps/telemetry');
    const migration = join(
      app,
      'database/migrations/1790900000000_retained.sql',
    );
    writeFileSync(
      migration,
      '-- Up Migration\nSELECT 1;\n-- Down Migration\nSELECT 1;\n',
    );
    writeFileSync(
      join(app, 'application.json'),
      JSON.stringify({
        name: 'telemetry',
        persistence: false,
        messaging: false,
        exposure: false,
      }),
    );
    const check = async ({ url }: { url: string }) => {
      expect((await fetch(`${url}/health/ready`)).status).toBe(200);
      for (const component of ['database', 'consumer', 'publisher'])
        expect(
          await (await fetch(`${url}/health/ready/${component}`)).json(),
        ).toMatchObject({ status: 'not_applicable' });
      expect((await fetch(`${url}/graphql`)).status).toBe(404);
    };
    await withApp(
      {
        cwd: workspace.root,
        command: ['src/apps/telemetry/main.ts'],
        settings: {},
      },
      check,
    );
    await run(workspace, ['bun', 'run', 'nx', 'run', 'telemetry:distribution']);
    const artifact = join(delivery, 'telemetry');
    cpSync(join(workspace.root, 'dist/telemetry'), artifact, {
      recursive: true,
      verbatimSymlinks: true,
    });
    expect(existsSync(migration)).toBe(true);
    for (const path of [
      'database',
      'app/database',
      'app/adapters/rabbitmq.transport.ts',
      'app/adapters/status.resolver.ts',
    ])
      expect(existsSync(join(artifact, path)), path).toBe(false);
    const manifest = JSON.parse(
      readFileSync(join(artifact, 'package.json'), 'utf8'),
    ) as {
      scripts: Record<string, string>;
      dependencies: Record<string, string>;
    };
    expect(Object.keys(manifest.scripts).sort()).toEqual([
      'preflight',
      'start',
    ]);
    for (const dependency of [
      'slonik',
      '@starter/rabbitmq',
      'amqplib',
      '@nestjs/apollo',
    ])
      expect(manifest.dependencies[dependency], dependency).toBeUndefined();
    await workspace.cleanup();
    await withApp(
      { cwd: artifact, command: ['run', 'start'], settings: {} },
      check,
    );
    await withApp(
      {
        cwd: artifact,
        command: ['run', 'start'],
        settings: {
          TELEMETRY_DB_HOST: '127.0.0.1',
          TELEMETRY_DB_PORT: sentinel.port,
          TELEMETRY_DB_NAME: 'sentinel',
          TELEMETRY_DB_USERNAME: 'sentinel',
          TELEMETRY_DB_PASSWORD: 'sentinel',
          TELEMETRY_RABBITMQ_URL: `amqp://sentinel:sentinel@127.0.0.1:${sentinel.port}`,
        },
      },
      async (running) => {
        await check(running);
        await Bun.sleep(1500);
        expect(sentinel.attempts()).toBe(0);
        expect(running.logs()).not.toContain('consumer.unavailable');
      },
    );
  }, [
    workspace.cleanup,
    () => sentinel.close(),
    () => {
      rmSync(delivery, { recursive: true, force: true });
    },
  ]);
}, 120_000);

test('source startup rejects incompatible User functionality before contacting dependencies', async () => {
  const workspace = await createWorkspace();
  const database = await tcpGate();
  const broker = await tcpGate();
  await withCleanup(async () => {
    const file = join(workspace.root, 'src/apps/user/application.json');
    const declaration = JSON.parse(readFileSync(file, 'utf8')) as object;
    writeFileSync(file, JSON.stringify({ ...declaration, persistence: false }));
    const result = await runCommand(
      [process.execPath, '--no-env-file', 'src/apps/user/main.ts'],
      {
        cwd: workspace.root,
        env: {
          PATH: process.env.PATH,
          USER_HTTP_PORT: '34991',
          USER_DB_HOST: '127.0.0.1',
          USER_DB_PORT: database.port,
          USER_DB_NAME: 'uncontacted',
          USER_DB_USERNAME: 'uncontacted',
          USER_DB_PASSWORD: 'private-preflight-password',
          RABBITMQ_HOST: '127.0.0.1',
          RABBITMQ_PORT: broker.port,
        },
      },
    );
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('user-profile requires persistence');
    expect(result.stderr).not.toContain('private-preflight-password');
    for (const command of [
      ['run', 'migration:up'],
      ['run', 'seed:up'],
      [
        'run',
        'nx',
        'run',
        'user:failures-replay',
        '--environment=development',
        '--run=preflight',
        '--message=uncontacted',
      ],
    ]) {
      const refused = await runCommand(
        [process.execPath, '--no-env-file', ...command],
        {
          cwd: workspace.root,
          env: { PATH: process.env.PATH },
          timeout: 30_000,
        },
      );
      expect(refused.code).not.toBe(0);
      expect(refused.stdout + refused.stderr).toContain(
        'user-profile requires persistence',
      );
    }
    expect(database.attempts()).toBe(0);
    expect(broker.attempts()).toBe(0);
  }, [() => database.close(), () => broker.close(), () => workspace.cleanup()]);
}, 60_000);

test('environment preparation rejects incompatible groups before Docker or inventory changes', async () => {
  const workspace = await createWorkspace();
  try {
    const file = join(workspace.root, 'src/apps/wallet/application.json');
    writeFileSync(
      file,
      JSON.stringify({
        name: 'wallet',
        persistence: true,
        messaging: false,
        exposure: true,
      }),
    );
    const bin = join(workspace.root, 'sentinels');
    mkdirSync(bin);
    writeFileSync(
      join(bin, 'docker'),
      '#!/bin/sh\ntouch docker-contacted\nexit 91\n',
      { mode: 0o755 },
    );
    const result = await runCommand(
      [
        process.execPath,
        '--no-env-file',
        'run',
        'env:prepare',
        '--environment=test',
        '--run=preflight',
        '--app=wallet',
      ],
      {
        cwd: workspace.root,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
        timeout: 30_000,
      },
    );
    expect(result.code).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(
      'wallet-creation requires messaging',
    );
    expect(existsSync(join(workspace.root, 'docker-contacted'))).toBe(false);
    expect(existsSync(join(workspace.root, '.context/test-runs'))).toBe(false);
  } finally {
    await workspace.cleanup();
  }
}, 60_000);

test('User distribution carries executable private libraries and only its own source and migrations', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'starter-distribution-'));
  const artifact = join(directory, 'user');
  try {
    const packaged = await runCommand(
      [
        process.execPath,
        '--no-env-file',
        'scripts/distribute.ts',
        'user',
        `--output=${artifact}`,
      ],
      { cwd: root, timeout: 60_000 },
    );
    expect(packaged, packaged.stderr).toMatchObject({ code: 0 });
    expect(existsSync(join(artifact, 'app/main.ts'))).toBe(true);
    expect(existsSync(join(artifact, 'app/tests'))).toBe(false);
    expect(existsSync(join(artifact, 'src'))).toBe(false);
    for (const file of readdirSync(artifact, {
      recursive: true,
      withFileTypes: true,
    })) {
      if (file.isSymbolicLink())
        expect(realpathSync(join(file.parentPath, file.name))).toStartWith(
          `${realpathSync(artifact)}/`,
        );
    }
    expect(
      readdirSync(join(artifact, 'app/database/migrations')).sort(),
    ).toEqual([
      '1790813453459_user-baseline.sql',
      '1790813453460_user-publication.sql',
    ]);
    const probe = await runCommand(
      [
        process.execPath,
        '--no-env-file',
        '-e',
        "import { Guard } from '@starter/core/guard'; import 'reflect-metadata'; import './app/app.module.ts'; console.log(Guard.isEmpty(''));",
      ],
      { cwd: artifact, env: { PATH: process.env.PATH }, timeout: 20_000 },
    );
    expect(probe, probe.stderr).toMatchObject({ code: 0, stdout: 'true\n' });
    const preflight = await runCommand(
      [process.execPath, '--no-env-file', 'run', 'preflight'],
      { cwd: artifact, env: { PATH: process.env.PATH } },
    );
    expect(preflight.code, preflight.stderr).toBe(0);
    expect(JSON.parse(preflight.stdout)).toMatchObject({
      name: 'user',
      persistence: true,
    });
    const declarationFile = join(artifact, 'app/application.json');
    const declaration = readFileSync(declarationFile, 'utf8');
    writeFileSync(
      declarationFile,
      JSON.stringify({
        ...(JSON.parse(declaration) as object),
        messaging: false,
      }),
    );
    const database = await tcpGate();
    await withCleanup(async () => {
      for (const command of ['preflight', 'start']) {
        const rejected = await runCommand(
          [process.execPath, '--no-env-file', 'run', command],
          {
            cwd: artifact,
            env: {
              PATH: process.env.PATH,
              USER_HTTP_PORT: '34991',
              USER_DB_HOST: '127.0.0.1',
              USER_DB_PORT: database.port,
              USER_DB_NAME: 'uncontacted',
              USER_DB_USERNAME: 'uncontacted',
              USER_DB_PASSWORD: 'private-password',
            },
          },
        );
        expect(rejected.code).not.toBe(0);
        expect(rejected.stderr).toContain('user-delivery requires messaging');
        expect(rejected.stderr).not.toContain('private-password');
      }
      expect(database.attempts()).toBe(0);
    }, [() => database.close()]);
    writeFileSync(declarationFile, declaration);
    const refused = await runCommand(
      [process.execPath, '--no-env-file', 'run', 'migration:up'],
      {
        cwd: artifact,
        env: { PATH: process.env.PATH, DATABASE_APP: 'wallet' },
      },
    );
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('This distribution owns only user');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 90_000);

test('distribution migration interface follows the application declaration', async () => {
  const workspace = await createWorkspace();
  try {
    // The packaging closure must be installed inside this copy, never shared links.
    rmSync(join(workspace.root, 'node_modules'), {
      recursive: true,
      force: true,
    });
    const installed = await workspace.run([
      process.execPath,
      'install',
      '--frozen-lockfile',
      '--ignore-scripts',
    ]);
    expect(installed, installed.stderr).toMatchObject({ code: 0 });
    mkdirSync(join(workspace.root, 'docs'), { recursive: true });
    cpSync(
      join(root, 'docs/distribution.md'),
      join(workspace.root, 'docs/distribution.md'),
    );
    const declaration = join(workspace.root, 'src/apps/user/application.json');
    const declared = readFileSync(declaration, 'utf8');
    writeFileSync(
      declaration,
      JSON.stringify({
        ...(JSON.parse(declared) as object),
        persistence: false,
      }),
    );
    const package_ = [
      process.execPath,
      '--no-env-file',
      'scripts/distribute.ts',
      'user',
    ];
    const undeclared = await workspace.run(package_);
    expect(undeclared.code).toBe(1);
    expect(undeclared.stderr).toContain('user-profile requires persistence');
    writeFileSync(declaration, declared);
    const packaged = await workspace.run(package_);
    expect(packaged, packaged.stderr).toMatchObject({ code: 0 });
    const artifact = join(workspace.root, 'dist/user');
    const refused = await runCommand(
      [process.execPath, '--no-env-file', 'run', 'migration:up'],
      {
        cwd: artifact,
        env: {
          PATH: process.env.PATH,
          USER_DB_PORT: '5432',
          USER_DB_MIGRATION_USERNAME: 'user_runtime',
        },
      },
    );
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('Migrations require the owner role');
    expect(
      JSON.parse(
        readFileSync(join(artifact, 'distribution.json'), 'utf8'),
      ) as unknown,
    ).toMatchObject({
      service: 'user',
      database: {
        prefix: 'USER_DB',
        runtimeRole: 'user_runtime',
        migrations: 'app/database/migrations',
      },
    });
    // A persistent application lists only its runtime imports; packaging
    // supplies the migration tooling's own dependencies.
    const ledger = join(workspace.root, 'src/apps/ledger');
    mkdirSync(join(ledger, 'database/migrations'), { recursive: true });
    for (const [file, content] of Object.entries({
      'project.json': { name: 'ledger', projectType: 'application' },
      'application.json': {
        name: 'ledger',
        persistence: true,
        messaging: false,
        exposure: false,
      },
      'distribution.json': [],
      'composition.json': { integrations: ['persistence'], groups: [] },
    }))
      writeFileSync(join(ledger, file), JSON.stringify(content));
    // Outside the workspace, so its node_modules cannot satisfy the artifact.
    const delivery = mkdtempSync(join(tmpdir(), 'starter-ledger-'));
    try {
      const ledgerPackaged = await workspace.run([
        process.execPath,
        '--no-env-file',
        'scripts/distribute.ts',
        'ledger',
        `--output=${join(delivery, 'ledger')}`,
      ]);
      expect(ledgerPackaged, ledgerPackaged.stderr).toMatchObject({ code: 0 });
      const unconfigured = await runCommand(
        [process.execPath, '--no-env-file', 'run', 'migration:up'],
        { cwd: join(delivery, 'ledger'), env: { PATH: process.env.PATH } },
      );
      expect(unconfigured.code).toBe(1);
      expect(unconfigured.stderr).toContain('Missing LEDGER_DB_PORT');
    } finally {
      rmSync(delivery, { recursive: true, force: true });
    }
  } finally {
    await workspace.cleanup();
  }
}, 90_000);

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
import { runCommand } from '../lib/command';
import { createWorkspace } from './workspace-fixture';

const root = new URL('../../', import.meta.url).pathname;

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
    mkdirSync(join(workspace.root, 'docs'));
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
    expect(undeclared.stderr).toContain(
      'Declare persistence in application.json',
    );
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

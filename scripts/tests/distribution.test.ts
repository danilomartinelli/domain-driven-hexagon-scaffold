import {
  cpSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
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

test('distribution migration configuration follows the selected application registry', async () => {
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
    const registry = join(workspace.root, 'database/applications.ts');
    writeFileSync(
      registry,
      readFileSync(registry, 'utf8')
        .replace("prefix: 'USER_DB'", "prefix: 'PROFILE_DB'")
        .replace("runtimeRole: 'user_runtime'", "runtimeRole: 'profile_reader'")
        .replace(
          '../src/apps/user/database/migrations/',
          '../src/apps/user/database/schema-changes/',
        ),
    );
    renameSync(
      join(workspace.root, 'src/apps/user/database/migrations'),
      join(workspace.root, 'src/apps/user/database/schema-changes'),
    );
    const packaged = await workspace.run([
      process.execPath,
      '--no-env-file',
      'scripts/distribute.ts',
      'user',
    ]);
    expect(packaged, packaged.stderr).toMatchObject({ code: 0 });
    const artifact = join(workspace.root, 'dist/user');
    const refused = await runCommand(
      [process.execPath, '--no-env-file', 'run', 'migration:up'],
      {
        cwd: artifact,
        env: {
          PATH: process.env.PATH,
          PROFILE_DB_PORT: '5432',
          PROFILE_DB_MIGRATION_USERNAME: 'profile_reader',
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
        prefix: 'PROFILE_DB',
        runtimeRole: 'profile_reader',
        migrations: 'app/database/schema-changes',
      },
    });
  } finally {
    await workspace.cleanup();
  }
}, 90_000);

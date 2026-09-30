import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommand } from '../lib/command';

const root = new URL('../../', import.meta.url).pathname;

test('direct test cleanup and database tools reject an unowned target before connecting', async () => {
  for (const command of [
    ['test', '--preload', './tests/setup/preload.ts', './tests/user'],
    [
      'test',
      '--preload',
      './src/apps/wallet/tests/component/preload.ts',
      './src/apps/wallet/tests/component',
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

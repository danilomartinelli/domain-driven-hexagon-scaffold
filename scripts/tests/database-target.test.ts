import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommand } from '../lib/command';

const root = new URL('../../', import.meta.url).pathname;

test('database tooling outside a selected environment reads .env with shell precedence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'starter-target-'));
  try {
    // Disable Bun's own loading, as the repository does, so only tooling reads .env.
    await writeFile(
      join(directory, 'bunfig.toml'),
      await readFile(join(root, 'bunfig.toml')),
    );
    await writeFile(
      join(directory, '.env'),
      'USER_DB_HOST=file-host\nUSER_DB_PORT=6543\nUSER_DB_MIGRATION_USERNAME=file-user\nUSER_DB_MIGRATION_PASSWORD=file-password\nUSER_DB_NAME=file-name\n',
    );
    // No selected environment, test mode, application selection or inherited
    // database settings (such as an env:exec session's); only USER_DB_NAME is shell.
    const env: NodeJS.ProcessEnv = {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          ([name]) =>
            !/^(DDH_ENVIRONMENT_FILE|NODE_ENV|DATABASE_APP)$|(^|_)USER_DB_/.test(
              name,
            ),
        ),
      ),
      USER_DB_NAME: 'shell-name',
    };
    const result = await runCommand(
      [
        process.execPath,
        '-e',
        `import { databaseTarget } from ${JSON.stringify(join(root, 'database/target.ts'))};
         console.log('TARGET=' + JSON.stringify(databaseTarget().connection));`,
      ],
      { cwd: directory, env },
    );
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(
      JSON.parse(/^TARGET=(.+)$/m.exec(result.stdout)?.[1] ?? 'null'),
    ).toEqual({
      host: 'file-host',
      port: 6543,
      user: 'file-user',
      password: 'file-password',
      database: 'shell-name',
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

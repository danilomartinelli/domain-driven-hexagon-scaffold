import { expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommand } from '../lib/command';
import { backupApplication } from '../lib/operations-backup';
import { operationsDiagnostics } from '../lib/operations-diagnostics';
import type { DeploymentState } from '../lib/operations-config';
import { operationsCompose } from '../lib/operations-compose';
import { until } from './app-runtime-fixture';
import { withCleanup } from './cleanup';

function secretState(directory: string): DeploymentState {
  const image = `example/user@sha256:${'a'.repeat(64)}`;
  return {
    version: 1,
    project: 'owned',
    owner: 'owner',
    directory,
    config: { name: 'example', images: { user: image } },
    artifacts: [
      {
        image,
        declaration: {
          name: 'user',
          persistence: true,
          messaging: true,
          exposure: false,
        },
      },
    ],
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

test('SIGHUP during preparation stops the child and releases the operation lock', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ddh-operations-hangup-'));
  const marker = join(directory, 'child.pid');
  writeFileSync(
    join(directory, 'deployment.json'),
    JSON.stringify(secretState(directory).config),
  );
  writeFileSync(
    join(directory, 'docker'),
    `#!/usr/bin/env bun\nawait Bun.write(${JSON.stringify(marker)}, String(process.pid));\nawait Bun.sleep(30000);\n`,
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
  const state: DeploymentState = {
    version: 1,
    project: 'owned',
    owner: 'owner',
    directory,
    config: { name: 'example', images: { user: image } },
    artifacts: [app],
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

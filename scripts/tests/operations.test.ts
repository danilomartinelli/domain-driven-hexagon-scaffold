import { expect, test } from 'bun:test';
import {
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

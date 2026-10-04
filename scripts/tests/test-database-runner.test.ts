import { expect, test } from 'bun:test';
import type { Subprocess } from 'bun';
import { join } from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { withCleanup } from './cleanup';

const root = join(import.meta.dir, '../..');
const resultSchema = z.object({
  project: z.string(),
  exitCode: z.number(),
  cleanupExitCode: z.number(),
  commandExitCode: z.number(),
});

async function runProbe(
  code: number,
  waitForCleanup?: string,
): Promise<{ project: string; exitCode: number }> {
  const child = Bun.spawn(
    [
      process.execPath,
      'scripts/with-test-database.ts',
      '--',
      process.execPath,
      '-e',
      `const pg = await import('pg');
     const client = new pg.default.Client({ host: process.env.USER_DB_HOST, port: Number(process.env.USER_DB_PORT), user: process.env.USER_DB_MIGRATION_USERNAME, password: process.env.USER_DB_MIGRATION_PASSWORD, database: process.env.USER_DB_NAME });
     await client.connect();
     const waitForCleanup = ${JSON.stringify(waitForCleanup)};
     const deadline = Date.now() + 60000;
     while (waitForCleanup && !await Bun.file(waitForCleanup).exists()) {
       if (Date.now() > deadline) throw new Error('Sibling cleanup did not finish');
       await Bun.sleep(20);
     }
     const migrations = await client.query('SELECT name FROM pgmigrations');
     if (migrations.rows.length !== 2) throw new Error('Baseline migration missing');
     await client.end();
     console.log('probe completed');
     if (${String(code)} !== 0) console.error('probe failure: expected successful delivery');
     process.exit(${String(code)});`,
    ],
    {
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(exitCode, stdout + stderr).toBe(code);
  expect(stdout).toContain('probe completed');
  const project = await assertCleanedUp(stdout, stderr, code);
  const log = `.context/test-runs/${project}/run.log`;
  expect(stdout.trimEnd().split('\n').at(-1)).toBe(
    `Result: exit ${String(code)} (command ${String(code)}, cleanup 0); log ${log}`,
  );
  // Container logs stay in run.log and reach the terminal only on failure.
  const containerLog = /^\S+-1\s+\| /m;
  expect(containerLog.test(stdout)).toBe(code !== 0);
  expect(await Bun.file(join(root, log)).text()).toMatch(containerLog);
  if (code !== 0) {
    const summary = stdout.slice(stdout.lastIndexOf('Failure excerpt'));
    expect(summary).toContain('probe failure: expected successful delivery');
    expect(summary).toContain('Result: exit 23 (command 23, cleanup 0)');
    expect(containerLog.test(summary)).toBe(false);
  } else expect(stdout).not.toContain('Failure excerpt');
  return { project, exitCode };
}

test('isolated database runs preserve success/failure codes and clean only their own resources', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ddh-runner-probe-'));
  const barrier = join(directory, 'sibling-cleaned');
  await withCleanup(async () => {
    const successRun = runProbe(0, barrier);
    const failureRun = withCleanup(
      () => runProbe(23),
      [() => writeFile(barrier, 'cleanup finished')],
    );
    const results = await Promise.allSettled([successRun, failureRun]);
    const [success, failure] = results.map((result) => {
      if (result.status === 'rejected') throw result.reason;
      return result.value;
    });
    expect(success.project).not.toBe(failure.project);
  }, [() => rm(directory, { recursive: true, force: true })]);
}, 120_000);

async function assertCleanedUp(
  stdout: string,
  stderr: string,
  code: number,
  commandCode = code,
): Promise<string> {
  const project = /Test run: (ddh-test-[a-z0-9-]+)/.exec(stdout)?.[1];
  if (!project)
    throw new Error(
      `Runner did not identify its resources: ${stdout}${stderr}`,
    );
  const result = resultSchema.parse(
    await Bun.file(
      join(root, '.context/test-runs', project, 'result.json'),
    ).json(),
  );
  expect(result).toMatchObject({
    project,
    exitCode: code,
    commandExitCode: commandCode,
    cleanupExitCode: 0,
  });
  expect(
    await Bun.file(join(root, '.context/test-runs', project, 'run.log')).text(),
  ).toContain('probe');
  const remaining = Bun.spawn(
    [
      'docker',
      'ps',
      '-aq',
      '--filter',
      `label=com.docker.compose.project=${project}`,
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  expect(await new Response(remaining.stdout).text()).toBe('');
  expect(await remaining.exited).toBe(0);

  const networks = Bun.spawn(
    [
      'docker',
      'network',
      'ls',
      '-q',
      '--filter',
      `label=com.docker.compose.project=${project}`,
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  expect(await new Response(networks.stdout).text()).toBe('');
  expect(await networks.exited).toBe(0);
  return project;
}

/** Run a command until its output shows the marker, then interrupt it once. */
async function interruptAtMarker(
  command: string[],
  marker: string,
  interrupt: (child: Subprocess) => void,
  {
    detached = false,
    deadlineMs = 60_000,
    deadlineAfterMarkerMs,
  }: {
    detached?: boolean;
    deadlineMs?: number;
    deadlineAfterMarkerMs?: number;
  } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const child = Bun.spawn(command, {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
    detached,
  });
  const stderr = new Response(child.stderr).text();
  let stdout = '';
  let interrupted = false;
  let forceKill: ReturnType<typeof setTimeout> | undefined;
  const signal = (value: 'SIGTERM' | 'SIGKILL') => {
    try {
      if (detached) process.kill(-child.pid, value);
      else child.kill(value);
    } catch (error) {
      if (!(
        error instanceof Error &&
        'code' in error &&
        error.code === 'ESRCH'
      ))
        throw error;
    }
  };
  // Nx tasks own separate process groups. Let Nx forward termination and wait
  // for runner cleanup before escalating, using the package wrapper's grace.
  const terminate = () => {
    signal('SIGTERM');
    forceKill = setTimeout(() => {
      signal('SIGKILL');
    }, 90_000);
  };
  let timeout = setTimeout(terminate, deadlineMs);
  try {
    for await (const chunk of child.stdout.pipeThrough(
      new TextDecoderStream(),
    )) {
      stdout += chunk;
      if (!interrupted && stdout.includes(marker)) {
        interrupted = true;
        if (deadlineAfterMarkerMs !== undefined) {
          clearTimeout(timeout);
          timeout = setTimeout(terminate, deadlineAfterMarkerMs);
        }
        interrupt(child);
      }
    }
    const exitCode = await child.exited;
    expect(interrupted, stdout + (await stderr)).toBe(true);
    return { stdout, stderr: await stderr, exitCode };
  } finally {
    clearTimeout(timeout);
    clearTimeout(forceKill);
  }
}

async function runInterruptedProbe(
  script: string,
  marker: string,
  commandExitCode: number,
): Promise<void> {
  const { stdout, stderr, exitCode } = await interruptAtMarker(
    [
      process.execPath,
      'scripts/with-test-database.ts',
      '--',
      process.execPath,
      '-e',
      script,
    ],
    marker,
    (child) => {
      child.kill('SIGTERM');
    },
  );
  expect(exitCode, stdout + stderr).toBe(143);
  await assertCleanedUp(stdout, stderr, 143, commandExitCode);
}

test('interrupting a running command returns SIGTERM status after resource cleanup', async () => {
  await runInterruptedProbe(
    "process.on('SIGTERM', () => {}); console.log('probe waiting'); setInterval(() => {}, 1000);",
    '\nprobe waiting\n',
    137,
  );
}, 90_000);

test('an interruption during cleanup is retained while owned resources are removed', async () => {
  await runInterruptedProbe(
    "console.log('probe completed');",
    ' logs --no-color\n',
    0,
  );
}, 90_000);

test.each(['interrupt', 'deadline'])(
  'an Nx-hosted run cleans up and records after %s while its command drains past the default kill grace',
  async (termination) => {
    const { stdout, stderr } = await interruptAtMarker(
      [
        process.execPath,
        'run',
        'nx',
        'run',
        'test-runner:with-database',
        '--',
        process.execPath,
        'scripts/tests/fixtures/draining-command.ts',
      ],
      '\nprobe draining\n',
      (child) => {
        // The deadline case deliberately leaves termination to the harness.
        if (termination === 'deadline') return;
        // Ctrl-C reaches the whole foreground group; Nx then stops the task tree.
        process.kill(-child.pid, 'SIGINT');
      },
      {
        detached: true,
        deadlineMs: 80_000,
        // Inject the deadline only after startup reaches the draining command.
        deadlineAfterMarkerMs: termination === 'deadline' ? 1_000 : undefined,
      },
    );
    await assertCleanedUp(stdout, stderr, 143, 143);
    const pid = /probe process: (\d+)/.exec(stdout)?.[1];
    expect(pid).toBeDefined();
    expect(() => process.kill(Number(pid), 0)).toThrow();
  },
  180_000,
);

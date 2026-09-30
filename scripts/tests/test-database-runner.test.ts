import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { z } from 'zod';

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
     const client = new pg.default.Client({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT), user: process.env.DB_USERNAME, password: process.env.DB_PASSWORD, database: process.env.DB_NAME });
     await client.connect();
     const waitForCleanup = ${JSON.stringify(waitForCleanup)};
     const deadline = Date.now() + 60000;
     while (waitForCleanup && !await Bun.file(waitForCleanup).exists()) {
       if (Date.now() > deadline) throw new Error('Sibling cleanup did not finish');
       await Bun.sleep(20);
     }
     const migrations = await client.query('SELECT name FROM pgmigrations');
     if (migrations.rows.length !== 1) throw new Error('Baseline migration missing');
     await client.end();
     console.log('probe completed');
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
  return { project, exitCode };
}

test('isolated database runs preserve success/failure codes and clean only their own resources', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ddh-runner-probe-'));
  const barrier = join(directory, 'sibling-cleaned');
  try {
    const successRun = runProbe(0, barrier);
    const failureRun = runProbe(23).finally(async () => {
      await writeFile(barrier, 'cleanup finished');
    });
    const results = await Promise.allSettled([successRun, failureRun]);
    const [success, failure] = results.map((result) => {
      if (result.status === 'rejected') throw result.reason;
      return result.value;
    });
    expect(success.project).not.toBe(failure.project);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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

async function runInterruptedProbe(
  script: string,
  marker: string,
  commandExitCode: number,
): Promise<void> {
  const child = Bun.spawn(
    [
      process.execPath,
      'scripts/with-test-database.ts',
      '--',
      process.execPath,
      '-e',
      script,
    ],
    { cwd: root, stdout: 'pipe', stderr: 'pipe' },
  );
  const stderr = new Response(child.stderr).text();
  let stdout = '';
  let interrupted = false;
  const timeout = setTimeout(() => {
    child.kill('SIGTERM');
  }, 60_000);
  try {
    for await (const chunk of child.stdout.pipeThrough(
      new TextDecoderStream(),
    )) {
      stdout += chunk;
      if (!interrupted && stdout.includes(marker)) {
        interrupted = true;
        child.kill('SIGTERM');
      }
    }
    expect(await child.exited, stdout + (await stderr)).toBe(143);
    expect(interrupted).toBe(true);
    await assertCleanedUp(stdout, await stderr, 143, commandExitCode);
  } finally {
    clearTimeout(timeout);
  }
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

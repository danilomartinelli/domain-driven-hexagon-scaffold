/**
 * Run tests from this checkout against a base commit, so a behaviour-preserving
 * change can show its tests encode the behaviour that existed before it.
 *
 *   bun run characterize -- [--base <ref>] <file>...
 *
 * Named files are copied into a temporary worktree of the base; `*.test.ts`
 * files run there. Files under `tests/` use the provisioned database runner.
 */
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, openSync, readFileSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { runCommand } from './lib/command';
import { bunTestCounts, describeCounts } from './lib/test-counts';

const TEST_DEADLINE = 900_000;
// Time for the provisioned runner's Docker cleanup before a forced stop.
const CLEANUP_GRACE = 60_000;

const args = process.argv.slice(2).filter((arg) => arg !== '--');
const baseIndex = args.indexOf('--base');
const baseRef = baseIndex === -1 ? undefined : args[baseIndex + 1];
const files = args.filter(
  (_, index) =>
    baseIndex === -1 || (index !== baseIndex && index !== baseIndex + 1),
);
const tests = files.filter((file) => file.endsWith('.test.ts'));
const live = tests.filter((file) => file.startsWith('tests/'));

async function git(cwd: string, ...gitArgs: string[]): Promise<string> {
  const result = await runCommand(['git', ...gitArgs], {
    cwd,
    timeout: 60_000,
  });
  if (result.code !== 0)
    throw new Error(`git ${gitArgs.join(' ')} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

/** Runs the tests with a deadline; the child receives our interruptions. */
async function runTests(worktree: string, log: string): Promise<number> {
  const command = live.length
    ? [
        process.execPath,
        'scripts/with-test-database.ts',
        '--',
        process.execPath,
        'test',
        '--preload',
        './tests/setup/preload.ts',
        ...tests.map((file) => `./${file}`),
      ]
    : [process.execPath, 'test', ...tests.map((file) => `./${file}`)];
  const output = openSync(log, 'w');
  const child = Bun.spawn(command, {
    cwd: worktree,
    stdin: 'ignore',
    stdout: output,
    stderr: output,
  });
  const termination = { timedOut: false };
  let forceKill: ReturnType<typeof setTimeout> | undefined;
  const deadline = setTimeout(() => {
    termination.timedOut = true;
    child.kill('SIGTERM');
    forceKill = setTimeout(() => {
      child.kill('SIGKILL');
    }, CLEANUP_GRACE);
  }, TEST_DEADLINE);
  // Forward interruptions; a terminal Ctrl-C also reaches the child directly,
  // and the runners ignore a repeated one.
  const forward = (received: NodeJS.Signals) => {
    child.kill(received);
  };
  process.on('SIGINT', forward);
  process.on('SIGTERM', forward);
  try {
    const code = await child.exited;
    return termination.timedOut ? 124 : code;
  } finally {
    clearTimeout(deadline);
    clearTimeout(forceKill);
    process.removeListener('SIGINT', forward);
    process.removeListener('SIGTERM', forward);
    closeSync(output);
  }
}

/** Copies the provisioned runner's records out; true unless every run cleaned up. */
async function keepRunnerRecords(
  worktree: string,
  destination: string,
): Promise<boolean> {
  const runs = join(worktree, '.context/test-runs');
  if (!existsSync(runs)) return false;
  await cp(runs, destination, { recursive: true });
  for (const run of await readdir(destination)) {
    const result = join(destination, run, 'result.json');
    // A run stopped before recording its result may still own resources.
    if (!existsSync(result)) return true;
    const { cleanupExitCode } = JSON.parse(readFileSync(result, 'utf8')) as {
      cleanupExitCode?: number;
    };
    if (cleanupExitCode !== 0) return true;
  }
  return false;
}

async function main(): Promise<number> {
  if (!tests.length || (baseIndex !== -1 && !baseRef))
    throw new Error(
      'Usage: characterize [--base <ref>] <file>... (at least one *.test.ts)',
    );
  if (live.length && live.length !== tests.length)
    throw new Error('Characterize tests/ suites and native tests separately.');
  const root = await git(process.cwd(), 'rev-parse', '--show-toplevel');
  const base = await git(
    root,
    'rev-parse',
    '--verify',
    `${baseRef ?? (await git(root, 'merge-base', 'HEAD', 'origin/master'))}^{commit}`,
  );
  const short = base.slice(0, 7);
  const record = join(
    root,
    '.context/characterize',
    `${short}-${randomUUID().slice(0, 8)}`,
  );
  await mkdir(record, { recursive: true });
  const log = join(record, 'output.log');
  const parent = await mkdtemp(join(tmpdir(), 'ddh-characterize-'));
  const worktree = join(parent, 'base');

  let signal: NodeJS.Signals | undefined;
  const onSignal = (received: NodeJS.Signals) => {
    signal = received;
  };
  const interruption = () =>
    signal === undefined ? undefined : signal === 'SIGINT' ? 130 : 143;
  const state = { added: false, keepWorktree: false };

  /** Each step checks for an interruption before starting the next. */
  async function characterizeAtBase(): Promise<number> {
    await git(root, 'worktree', 'add', '--detach', worktree, base);
    state.added = true;
    const install = await runCommand(
      [process.execPath, 'install', '--frozen-lockfile'],
      { cwd: worktree, timeout: 300_000 },
    );
    const stopped = interruption();
    if (stopped !== undefined) return stopped;
    if (install.code !== 0)
      throw new Error(`Installing the base failed: ${install.stderr.trim()}`);
    for (const file of files) {
      await mkdir(dirname(join(worktree, file)), { recursive: true });
      await cp(join(root, file), join(worktree, file));
    }
    const beforeTests = interruption();
    if (beforeTests !== undefined) return beforeTests;
    const code = await runTests(worktree, log);
    state.keepWorktree = await keepRunnerRecords(
      worktree,
      join(record, 'test-runs'),
    );
    console.log(
      `Characterization at ${short}: exit ${String(code)}; ` +
        describeCounts(bunTestCounts(readFileSync(log, 'utf8'))) +
        `log ${relative(root, log)}`,
    );
    return interruption() ?? code;
  }

  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  const failures: unknown[] = [];
  let code = 1;
  try {
    code = await characterizeAtBase();
  } catch (error) {
    failures.push(error);
  }
  // Attempt every cleanup; a runner that could not clean up keeps its worktree.
  const attempt = async (step: () => Promise<unknown>) => {
    try {
      await step();
    } catch (error) {
      failures.push(error);
    }
  };
  if (state.keepWorktree)
    console.error(
      `Kept ${worktree}: its test run did not confirm its cleanup. ` +
        `Inspect ${relative(root, record)}/test-runs and shut the run down from that worktree.`,
    );
  else {
    if (state.added)
      await attempt(() => git(root, 'worktree', 'remove', '--force', worktree));
    await attempt(() => rm(parent, { recursive: true, force: true }));
  }
  // Listeners stay until cleanup ends, so a repeated Ctrl-C cannot abandon it.
  process.removeListener('SIGINT', onSignal);
  process.removeListener('SIGTERM', onSignal);
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(failures, 'Characterization and cleanup failed');
  return code;
}

try {
  process.exitCode = await main();
} catch (error) {
  const errors = error instanceof AggregateError ? error.errors : [error];
  for (const each of errors)
    console.error(each instanceof Error ? each.message : each);
  process.exitCode = 2;
}

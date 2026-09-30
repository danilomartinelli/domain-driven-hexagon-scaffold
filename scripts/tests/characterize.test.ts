import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommand } from '../lib/command';
import { isolatedEnvironment } from './workspace-fixture';

const script = join(import.meta.dir, '../characterize.ts');

/** A repository whose base returns 1 and whose checkout changed it to 2. */
async function changedRepository(
  scripts: Record<string, string> = {},
): Promise<{ root: string; base: string }> {
  const root = await mkdtemp(join(tmpdir(), 'ddh-characterize-'));
  const git = async (...args: string[]) => {
    const result = await runCommand(['git', ...args], {
      cwd: root,
      env: isolatedEnvironment(),
    });
    expect(result.code, result.stderr).toBe(0);
    return result.stdout.trim();
  };
  await git('init', '--quiet', '--initial-branch=master');
  await git('config', 'user.email', 'probe@example.com');
  await git('config', 'user.name', 'probe');
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ name: 'probe', scripts }),
  );
  await writeFile(join(root, 'value.ts'), 'export const value = 1;\n');
  await git('add', '.');
  await git('commit', '--quiet', '-m', 'base');
  const base = await git('rev-parse', 'HEAD');
  await writeFile(join(root, 'value.ts'), 'export const value = 2;\n');
  await git('commit', '--quiet', '-am', 'change');
  return { root, base };
}

async function writeTest(root: string, body: string): Promise<void> {
  await writeFile(
    join(root, 'value.test.ts'),
    `import { expect, test } from 'bun:test';
import { value } from './value';
test('value', async () => { ${body} }, 60_000);\n`,
  );
}

function characterize(root: string, base: string) {
  return Bun.spawn(
    [process.execPath, script, '--base', base, 'value.test.ts'],
    { cwd: root, env: isolatedEnvironment(), stdout: 'pipe', stderr: 'pipe' },
  );
}

async function finished(child: ReturnType<typeof characterize>) {
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, code };
}

async function worktreeCount(root: string): Promise<number> {
  const list = await runCommand(['git', 'worktree', 'list'], {
    cwd: root,
    env: isolatedEnvironment(),
  });
  return list.stdout.trim().split('\n').length;
}

/** Wait for a condition the characterization reaches, then interrupt it. */
async function interruptWhen(
  child: ReturnType<typeof characterize>,
  ready: () => Promise<boolean>,
): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!(await ready())) {
    if (Date.now() > deadline) throw new Error('Characterization never ready');
    await Bun.sleep(50);
  }
  child.kill('SIGTERM');
}

test('tests from the checkout run against the base commit, then the worktree is removed', async () => {
  const { root, base } = await changedRepository();
  try {
    await writeTest(root, 'expect(value).toBe(1);');
    const kept = await finished(characterize(root, base));
    expect(kept.code, kept.stdout + kept.stderr).toBe(0);
    expect(kept.stdout).toMatch(
      new RegExp(
        `^Characterization at ${base.slice(0, 7)}: exit 0; bun test 1 pass, 0 fail; log \\.context/characterize/${base.slice(0, 7)}-\\S+/output\\.log$`,
        'm',
      ),
    );

    await writeTest(root, 'expect(value).toBe(2);');
    const changed = await finished(characterize(root, base));
    expect(changed.code).toBe(1);
    expect(changed.stdout).toContain('bun test 0 pass, 1 fail');
    expect(await worktreeCount(root)).toBe(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);

test('an interruption during the tests stops them and still removes the worktree', async () => {
  const { root, base } = await changedRepository();
  try {
    await writeTest(root, 'await Bun.sleep(30_000); expect(value).toBe(1);');
    const child = characterize(root, base);
    await interruptWhen(child, async () => {
      const runs = join(root, '.context/characterize');
      return (
        existsSync(runs) &&
        (await readdir(runs)).some((run) =>
          existsSync(join(runs, run, 'output.log')),
        )
      );
    });
    const result = await finished(child);
    expect(result.code, result.stdout + result.stderr).toBe(143);
    expect(await worktreeCount(root)).toBe(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);

test('an interruption before the tests start stops without running them', async () => {
  // The base installs slowly, leaving time to interrupt before the tests.
  const { root, base } = await changedRepository({ postinstall: 'sleep 3' });
  try {
    await writeTest(root, 'expect(value).toBe(1);');
    const child = characterize(root, base);
    await interruptWhen(child, async () => (await worktreeCount(root)) === 2);
    const result = await finished(child);
    expect(result.code, result.stdout + result.stderr).toBe(143);
    expect(result.stdout).not.toContain('bun test');
    expect(await worktreeCount(root)).toBe(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);

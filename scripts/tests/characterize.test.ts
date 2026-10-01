import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runCommand } from '../lib/command';
import { isolatedEnvironment } from './workspace-fixture';

const script = join(import.meta.dir, '../characterize.ts');

/** A repository whose base returns 1 and whose checkout changed it to 2. */
async function changedRepository(
  scripts: Record<string, string> = {},
  baseFiles: Record<string, string> = {},
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
  for (const [file, content] of Object.entries(baseFiles)) {
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), content);
  }
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

function characterize(root: string, base: string, files = ['value.test.ts']) {
  return Bun.spawn([process.execPath, script, '--base', base, ...files], {
    cwd: root,
    env: isolatedEnvironment(),
    stdout: 'pipe',
    stderr: 'pipe',
  });
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

test.each(['user', 'wallet', 'distributed'])(
  'characterization uses the %s runner scope and preload at the base',
  async (suite) => {
    const component = suite !== 'distributed';
    const testFile = component
      ? `src/apps/${suite}/tests/component/value.test.ts`
      : 'tests/integration/value.test.ts';
    const preload = component
      ? `src/apps/${suite}/tests/component/preload.ts`
      : 'tests/setup/preload.ts';
    // Bun consumes the separator when it is the first script argument.
    const runnerArgs = component ? [`--app=${suite}`, '--'] : [];
    // The fixture exposes the provisioned runner's subprocess protocol. The
    // test itself runs under Bun against the old source, through that protocol.
    const { root, base } = await changedRepository(
      {},
      {
        'scripts/with-test-database.ts': `
const args = process.argv.slice(2);
const expected = ${JSON.stringify(runnerArgs)};
if (expected.some((arg, index) => args[index] !== arg)) throw new Error('Wrong runner scope');
const child = Bun.spawn(args.slice(expected.length), { env: { ...process.env, CHARACTERIZE_OWNER: '${suite}' }, stdout: 'inherit', stderr: 'inherit' });
process.exitCode = await child.exited;
`,
        [preload]: `if (process.env.CHARACTERIZE_OWNER !== '${suite}') throw new Error('Missing owned environment');
process.env.CHARACTERIZE_PRELOADED = '${suite}';`,
      },
    );
    try {
      await mkdir(dirname(join(root, testFile)), { recursive: true });
      await writeFile(
        join(root, testFile),
        `import { expect, test } from 'bun:test';
import { value } from '${component ? '../../../../../value' : '../../value'}';
test('base suite', () => {
  expect(value).toBe(1);
  expect(process.env.CHARACTERIZE_OWNER).toBe('${suite}');
  expect(process.env.CHARACTERIZE_PRELOADED).toBe('${suite}');
});`,
      );
      const result = await finished(
        characterize(root, base, [`./${testFile}`]),
      );
      expect(result.code, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toContain('bun test 1 pass, 0 fail');
      expect(await worktreeCount(root)).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  120_000,
);

test.each([
  [
    'src/apps/user/tests/component/a.test.ts',
    'src/apps/wallet/tests/component/b.test.ts',
  ],
  [
    'src/apps/user/tests/component/a.test.ts',
    'src/apps/user/tests/unit/b.test.ts',
  ],
  ['src/apps/user/tests/component/a.test.ts', 'tests/integration/b.test.ts'],
  ['scripts/tests/a.test.ts', './tests/integration/b.test.ts'],
])(
  'mixed characterization suites are rejected before creating a worktree: %j',
  async (first, second) => {
    const { root, base } = await changedRepository();
    try {
      const result = await finished(characterize(root, base, [first, second]));
      expect(result.code).toBe(2);
      expect(result.stderr).toContain('Characterize one test suite at a time');
      expect(result.stdout).not.toContain('Characterization at');
      expect(await worktreeCount(root)).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  120_000,
);

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

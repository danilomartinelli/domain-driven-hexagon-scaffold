import { expect, test } from 'bun:test';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommand } from '../lib/command';

const firstHead = 'a'.repeat(40);
const nextHead = 'b'.repeat(40);
const script = new URL('../ci-watch.ts', import.meta.url).pathname;

function snapshot(
  head = firstHead,
  status = 'in_progress',
  conclusion = '',
  steps = [{ name: 'Check', status: 'in_progress', conclusion: '' }],
) {
  return {
    pr: {
      number: 52,
      url: 'https://github.com/example/project/pull/52',
      headRefOid: head,
      headRefName: 'feature',
      baseRefName: 'master',
      body: 'Closes #31. Related to #15.',
      closingIssuesReferences: [{ number: 31 }],
    },
    run: {
      databaseId: 123,
      url: 'https://github.com/example/project/actions/runs/123',
      headSha: head,
      status,
      conclusion,
      jobs: [{ name: 'check', status, conclusion, steps }],
    },
  };
}

async function watch(
  snapshots: unknown[],
  action: (
    result: Awaited<ReturnType<typeof runCommand>>,
    evidence: string,
  ) => void,
  options: string[] = [],
) {
  const root = await mkdtemp(join(tmpdir(), 'ddh-ci-watch-'));
  try {
    const gh = join(root, 'gh');
    await writeFile(join(root, 'snapshots.json'), JSON.stringify(snapshots));
    await writeFile(
      gh,
      `#!${process.execPath}
      import { readFileSync, writeFileSync, existsSync } from 'node:fs';
      const root = ${JSON.stringify(root)};
      const snapshots = JSON.parse(readFileSync(root + '/snapshots.json', 'utf8'));
      const stateFile = root + '/state';
      let index = existsSync(stateFile) ? Number(readFileSync(stateFile, 'utf8')) : -1;
      const args = process.argv.slice(2);
      if (args[0] === 'pr' && args[1] === 'view') { index = Math.min(index + 1, snapshots.length - 1); writeFileSync(stateFile, String(index)); }
      const value = snapshots[Math.max(0, index)];
      if (value.error) { console.error(value.error); process.exit(1); }
      if (args[0] === 'pr') console.log(JSON.stringify(value.pr));
      else if (args[0] === 'run' && args[1] === 'list') console.log(JSON.stringify(value.runs ?? (value.run ? [value.run] : [])));
      else if (args[0] === 'run' && args[1] === 'view') console.log(JSON.stringify(value.runs?.find(run => run.databaseId === Number(args[2])) ?? value.run));
      else { console.error('Unexpected gh request'); process.exit(1); }
    `,
    );
    await chmod(gh, 0o755);
    const evidence = join(root, 'evidence.json');
    const result = await runCommand(
      [
        process.execPath,
        script,
        '--pr=52',
        '--repo=example/project',
        '--interval-ms=10',
        '--timeout-ms=5000',
        `--output=${evidence}`,
        ...options,
      ],
      {
        cwd: root,
        timeout: 10_000,
        env: { ...process.env, PATH: `${root}:${process.env.PATH ?? ''}` },
      },
    );
    action(result, await readFile(evidence, 'utf8'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('CI watching emits changed stages once and records the verified terminal head', async () => {
  const running = snapshot();
  const done = snapshot(firstHead, 'completed', 'success', [
    { name: 'Check', status: 'completed', conclusion: 'success' },
  ]);
  await watch(
    [{ ...running, run: undefined }, running, running, done],
    (result, evidence) => {
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout.match(/check \/ Check/g)).toHaveLength(1);
      expect(result.stdout).toContain('[ci:passed]');
      expect(JSON.parse(evidence)).toMatchObject({
        status: 'passed',
        headSha: firstHead,
        pullRequest: { number: 52, closingIssuesReferences: [{ number: 31 }] },
      });
    },
  );
});

test('an old successful head cannot approve a newly pushed failing head', async () => {
  const old = snapshot(firstHead, 'completed', 'success', [
    { name: 'Check', status: 'completed', conclusion: 'success' },
  ]);
  const current = snapshot(nextHead, 'completed', 'failure', [
    { name: 'Check', status: 'completed', conclusion: 'failure' },
  ]);
  await watch([old, current], (result, evidence) => {
    expect(result.code, result.stderr).toBe(1);
    expect(result.stdout).not.toContain('[ci:passed]');
    expect(JSON.parse(evidence)).toMatchObject({
      status: 'failed',
      headSha: nextHead,
      observedHeads: [firstHead, nextHead],
    });
  });
});

test('CI that could not execute is distinct from failed tests', async () => {
  await watch(
    [snapshot(firstHead, 'completed', 'failure', [])],
    (result, evidence) => {
      expect(result.code, result.stderr).toBe(3);
      expect(JSON.parse(evidence)).toMatchObject({
        status: 'blocked',
        headSha: firstHead,
      });
    },
  );
});

test('GitHub access failure records unavailable evidence without approving CI', async () => {
  await watch([{ error: 'permission denied' }], (result, evidence) => {
    expect(result.code, result.stderr).toBe(2);
    expect(result.stdout).not.toContain('[ci:passed]');
    expect(JSON.parse(evidence)).toMatchObject({
      status: 'unavailable',
      reason: 'permission denied',
    });
  });
});

test('missing run registration remains pending until the bounded observation expires', async () => {
  await watch(
    [{ ...snapshot(), run: undefined }],
    (result, evidence) => {
      expect(result.code, result.stderr).toBe(4);
      expect(result.stdout.match(/waiting for CI registration/g)).toHaveLength(
        1,
      );
      expect(JSON.parse(evidence)).toMatchObject({
        status: 'timed_out',
        headSha: firstHead,
      });
    },
    ['--timeout-ms=600'],
  );
});

test('a run returned for a different SHA cannot approve the pull request', async () => {
  const wrong = snapshot();
  wrong.run.headSha = nextHead;
  await watch([wrong], (result, evidence) => {
    expect(result.code, result.stderr).toBe(2);
    expect(JSON.parse(evidence)).toMatchObject({
      status: 'unavailable',
      headSha: firstHead,
    });
  });
});

test('a newer pending run takes precedence over an older success on the same head', async () => {
  const old = snapshot(firstHead, 'completed', 'success', [
    { name: 'Check', status: 'completed', conclusion: 'success' },
  ]);
  const active = snapshot();
  active.run.databaseId = 124;
  const done = snapshot(firstHead, 'completed', 'success', [
    { name: 'Check', status: 'completed', conclusion: 'success' },
  ]);
  done.run.databaseId = 124;
  await watch(
    [
      { ...active, runs: [old.run, active.run] },
      { ...done, runs: [done.run, old.run] },
    ],
    (result, evidence) => {
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toContain('run 124: check / Check');
      expect(JSON.parse(evidence)).toMatchObject({
        status: 'passed',
        run: { databaseId: 124 },
      });
    },
  );
});

test('a rerun started during the final head check invalidates the previous attempt', async () => {
  const old = {
    ...snapshot(firstHead, 'completed', 'success', [
      { name: 'Check', status: 'completed', conclusion: 'success' },
    ]).run,
    attempt: 1,
  };
  const running = { ...snapshot().run, attempt: 2 };
  const failed = {
    ...snapshot(firstHead, 'completed', 'failure', [
      { name: 'Check', status: 'completed', conclusion: 'failure' },
    ]).run,
    attempt: 2,
  };
  await watch(
    [
      { ...snapshot(), run: old },
      { ...snapshot(), run: running },
      { ...snapshot(), run: failed },
    ],
    (result, evidence) => {
      expect(result.code, result.stderr).toBe(1);
      expect(result.stdout).not.toContain('[ci:passed]');
      expect(JSON.parse(evidence)).toMatchObject({
        status: 'failed',
        run: { attempt: 2 },
      });
    },
  );
});

test('malformed GitHub metadata is unavailable rather than successful', async () => {
  await watch(
    [{ pr: { ...snapshot().pr, headRefOid: 'invalid' } }],
    (result, evidence) => {
      expect(result.code, result.stderr).toBe(2);
      expect(JSON.parse(evidence)).toMatchObject({ status: 'unavailable' });
    },
  );
});

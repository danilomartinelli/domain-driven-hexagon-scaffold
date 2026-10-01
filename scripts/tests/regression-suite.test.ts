import { expect, test } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expectRegressionSuite } from './regression-suite';
import { createWorkspace } from './workspace-fixture';

test.each(['plain', 'GitHub Actions'])(
  'prepared suite discovery survives renamed files and rejects incomplete or failed runs (%s)',
  async (outputMode) => {
    const workspace = await createWorkspace();
    try {
      for (const group of ['user', 'integration']) {
        const directory = join(workspace.root, 'tests', group);
        await rm(directory, { recursive: true, force: true });
        await mkdir(directory);
        await writeFile(
          join(directory, 'renamed.test.ts'),
          "import { expect, test } from 'bun:test';\n" +
            "test.each([1, 2, 3, 4])('discovered probe %i', (value) => expect(value).toBeGreaterThan(0));\n",
        );
      }
      // Exercise the real prepared target and Bun discovery without starting apps.
      await writeFile(join(workspace.root, 'tests/setup/preload.ts'), '');
      const result = await workspace.run([
        'env',
        ...(outputMode === 'GitHub Actions'
          ? ['GITHUB_ACTIONS=true']
          : ['-u', 'GITHUB_ACTIONS']),
        'AGENT=0',
        process.execPath,
        'run',
        'test:e2e:prepared',
        '--output-style=static',
      ]);
      expect(result.code, result.stdout + result.stderr).toBe(0);
      const output = result.stderr + result.stdout;
      await expectRegressionSuite(workspace.root, output);
      await expectRejected(
        workspace.root,
        output.replace('tests/integration/renamed.test.ts:', ''),
        'Test file did not run',
      );
      await expectRejected(
        workspace.root,
        output.replace(/\b0 fail\b/, '1 fail'),
        'Prepared suite must report zero failures',
      );
      const added = join(workspace.root, 'tests/user/new.test.ts');
      await writeFile(added, '');
      await expectRejected(workspace.root, output, 'Test file did not run');
      await rm(added);
      await rm(join(workspace.root, 'tests/user/renamed.test.ts'));
      await expectRejected(workspace.root, output, 'No tests discovered');
    } finally {
      await workspace.cleanup();
    }
  },
  30_000,
);

async function expectRejected(
  root: string,
  output: string,
  message: string,
): Promise<void> {
  const [result] = await Promise.allSettled([
    expectRegressionSuite(root, output),
  ]);
  expect(result.status).toBe('rejected');
  if (result.status !== 'rejected') throw new Error('Expected rejected suite');
  const failure: unknown = result.reason;
  if (!(failure instanceof Error)) throw new Error('Expected suite error');
  expect(failure.message).toContain(message);
}

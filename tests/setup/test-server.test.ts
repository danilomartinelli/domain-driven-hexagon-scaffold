import { expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommand } from '../../scripts/lib/command';
import { withCleanup } from '../../scripts/tests/cleanup';

test.each(['startup', 'reset', 'cleanup', 'none'])(
  'fixture lifecycle preserves the primary failure across test files: %s',
  async (failure) => {
    const directory = await mkdtemp(join(tmpdir(), 'starter-lifecycle-'));
    await withCleanup(async () => {
      const files = [
        join(directory, 'first.test.ts'),
        join(directory, 'second.test.ts'),
      ];
      for (const file of files) {
        await writeFile(
          file,
          `import { test } from 'bun:test';
test('scenario', () => console.log('SCENARIO_RAN'));\n`,
        );
      }
      const result = await runCommand(
        [
          process.execPath,
          'test',
          '--preload',
          join(import.meta.dir, 'fixtures/lifecycle-preload.ts'),
          ...files,
        ],
        {
          cwd: join(import.meta.dir, '../..'),
          env: { ...process.env, FIXTURE_FAILURE: failure },
          timeout: 10_000,
        },
      );
      const output = result.stdout + result.stderr;
      expect(result.code, output).toBe(failure === 'none' ? 0 : 1);
      expect(output).not.toContain('error: POOL_CLOSED');
      expect(output).not.toContain('error: POOL_END_AGAIN');
      expect(result.stdout.match(/^POOL_ENDED$/gm)).toHaveLength(2);
      expect(result.stdout.match(/^SCENARIO_RAN$/gm) ?? []).toHaveLength(
        failure === 'none' ? 2 : failure === 'reset' ? 1 : 0,
      );
      if (failure !== 'none') expect(output).toContain('STARTUP_FAILED');
      if (failure === 'cleanup') expect(output).toContain('CLEANUP_FAILED');
    }, [() => rm(directory, { recursive: true, force: true })]);
  },
);

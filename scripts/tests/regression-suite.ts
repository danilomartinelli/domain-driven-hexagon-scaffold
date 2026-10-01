import { expect } from 'bun:test';
import { join } from 'node:path';
import { bunTestCounts } from '../lib/test-counts';

/** Require both Gherkin and database coverage from a prepared regression run. */
export async function expectRegressionSuite(
  root: string,
  output: string,
): Promise<void> {
  const text = Bun.stripANSI(output).replace(/^::group::/gm, '');
  for (const group of ['tests/user', 'tests/integration']) {
    const files = await Array.fromAsync(
      new Bun.Glob('**/*{.test,_test,.spec,_spec}.{ts,tsx,js,jsx}').scan({
        cwd: join(root, group),
        onlyFiles: true,
      }),
    );
    expect(files.length, `No tests discovered in ${group}`).toBeGreaterThan(0);
    for (const file of files) {
      const path = `${group}/${file}`;
      expect(
        text.includes(`\n${path}:\n`),
        `Test file did not run: ${path}`,
      ).toBe(true);
    }
  }
  const counts = bunTestCounts(text);
  expect(counts?.fail, 'Prepared suite must report zero failures').toBe(0);
  expect(
    counts?.pass ?? 0,
    'Prepared suite must run at least seven tests',
  ).toBeGreaterThanOrEqual(7);
}

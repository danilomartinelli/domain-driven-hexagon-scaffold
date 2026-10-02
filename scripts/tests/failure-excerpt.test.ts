import { expect, test } from 'bun:test';
import { failureExcerpt } from '../lib/failure-excerpt';
import { runCommand } from '../lib/command';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('failure excerpts retain real colored Bun assertions before later output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ddh-failure-excerpt-'));
  try {
    const file = join(root, 'probe.test.ts');
    await writeFile(
      file,
      `import { expect, test } from 'bun:test';
test('delivery probe', () => expect('retained').toBe('delivered'));
test('later noise', () => { for (let i = 0; i < 1100; i++) console.error('later output'); });`,
    );
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      FORCE_COLOR: '1',
      AGENT: '0',
    };
    delete env.NO_COLOR;
    const result = await runCommand([process.execPath, 'test', file], {
      cwd: root,
      env,
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('\u001b[');
    const excerpt = failureExcerpt(result.stderr);
    expect(excerpt).toContain('Expected: "delivered"');
    expect(excerpt).toContain('Received: "retained"');
    expect(excerpt).toMatch(/(?:\(fail\)|✗) delivery probe/);
    expect(excerpt).not.toContain('\u001b[');
    expect(excerpt.length).toBeLessThanOrEqual(16_000);
    expect(excerpt.split('\n').length).toBeLessThanOrEqual(93);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('unstructured failure output has a bounded tail', () => {
  const output = Array.from(
    { length: 1100 },
    (_, i) => `${String(i)} ${'x'.repeat(1000)}`,
  ).join('\n');
  const excerpt = failureExcerpt(output);
  expect(excerpt).toStartWith('1040 ');
  expect(excerpt).toContain('1099 ');
  expect(excerpt.length).toBeLessThanOrEqual(16_000);
  expect(excerpt.split('\n').every((line) => line.length <= 250)).toBe(true);
});

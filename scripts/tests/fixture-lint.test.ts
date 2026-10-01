import { expect, test } from 'bun:test';
import { ESLint } from 'eslint';

const eslint = new ESLint();
const asyncFinally = `export async function fixture(): Promise<void> {
  try { await Promise.resolve(); }
  finally { await Promise.reject(new Error('cleanup')); }
}`;

async function restrictions(source: string, filePath: string) {
  const [result] = await eslint.lintText(source, { filePath });
  expect(result.fatalErrorCount, JSON.stringify(result.messages)).toBe(0);
  return result.messages.filter(
    ({ ruleId }) => ruleId === 'no-restricted-syntax',
  );
}

test.each([
  'src/apps/wallet/tests/component/database-ownership.test.ts',
  'tests/integration/user-wallet.test.ts',
  'scripts/tests/environment.test.ts',
  'scripts/tests/test-database-runner.test.ts',
])(
  'rejects awaited finally cleanup in infrastructure fixture %s',
  async (filePath) => {
    const messages = await restrictions(asyncFinally, filePath);
    expect(messages).toHaveLength(1);
    expect(messages[0].message).toContain('withCleanup');
  },
);

test('synchronous fixture cleanup and production finalizers remain allowed', async () => {
  expect(
    await restrictions(
      asyncFinally.replace(
        "await Promise.reject(new Error('cleanup'))",
        'void 0',
      ),
      'src/apps/wallet/tests/component/database-ownership.test.ts',
    ),
  ).toEqual([]);
  expect(
    await restrictions(
      asyncFinally,
      'src/apps/wallet/messaging/rabbit-wallet-consumer.ts',
    ),
  ).toEqual([]);
});

test('fixture overrides retain the shared syntax restrictions', async () => {
  expect(
    await restrictions(
      'export class Fixture { set value(_value: string) {} }',
      'src/apps/wallet/tests/component/database-ownership.test.ts',
    ),
  ).toHaveLength(1);
});

test('withCleanup remains available to infrastructure fixtures', async () => {
  expect(
    await restrictions(
      `import { withCleanup } from '../../../../../scripts/tests/cleanup';
       export async function fixture(): Promise<void> {
         await withCleanup(() => Promise.resolve(), [() => Promise.resolve()]);
       }`,
      'src/apps/wallet/tests/component/database-ownership.test.ts',
    ),
  ).toEqual([]);
});

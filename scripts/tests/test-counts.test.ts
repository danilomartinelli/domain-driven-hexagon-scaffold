import { expect, test } from 'bun:test';
import { bunTestCounts } from '../lib/test-counts';

test('bun test summaries yield their final pass and fail counts', () => {
  const colored = '\u001b[32m 22 pass\u001b[0m\n\u001b[31m 0 fail\u001b[0m\n';
  expect(bunTestCounts(`bun test v1.4.2\n${colored}Ran 22 tests`)).toEqual({
    pass: 22,
    fail: 0,
  });
  // Nested runs report their own summaries; the last one is the outcome.
  expect(
    bunTestCounts(' 35 pass\n 0 fail\nlater\n 6 pass\n 1 fail\n 1 error\n'),
  ).toEqual({ pass: 6, fail: 1 });
});

test('output without a bun test summary yields no counts', () => {
  expect(bunTestCounts('probe completed\nexit 0\n')).toBeUndefined();
  expect(bunTestCounts('the 3 pass rate\n')).toBeUndefined();
});

import { expect, test } from 'bun:test';
import { withCleanup } from './cleanup';

test('a failed test retains its original error and every cleanup failure', async () => {
  const primary = new Error('preparation failed');
  const cleanup = new Error('first shutdown failed');
  const completed: string[] = [];
  let failure: unknown;
  try {
    await withCleanup(() => {
      throw primary;
    }, [
      () => {
        completed.push('first');
        throw cleanup;
      },
      async () => {
        await Promise.resolve();
        completed.push('second');
      },
    ]);
  } catch (error) {
    failure = error;
  }
  expect(completed).toEqual(['first', 'second']);
  expect(failure).toBeInstanceOf(AggregateError);
  if (!(failure instanceof AggregateError))
    throw new Error('Expected all failures');
  expect(failure.errors).toEqual([primary, cleanup]);
});

test('successful operations return their result after all cleanups complete', async () => {
  let cleaned = false;
  const result = await withCleanup(
    () => 42,
    [
      async () => {
        await Promise.resolve();
        cleaned = true;
      },
    ],
  );
  expect(result).toBe(42);
  expect(cleaned).toBe(true);
});

test('a single operation or cleanup failure keeps its original identity', async () => {
  const primary = new Error('original failure');
  const cleanup = new Error('cleanup failure');
  const results = await Promise.allSettled([
    withCleanup(() => {
      throw primary;
    }, [() => undefined]),
    withCleanup(
      () => 'success',
      [
        () => {
          throw cleanup;
        },
      ],
    ),
  ]);
  for (const [index, result] of results.entries()) {
    expect(result.status).toBe('rejected');
    if (result.status === 'rejected') {
      expect(result.reason).toBe([primary, cleanup][index]);
    }
  }
});

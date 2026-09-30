/** Keep the test's failure and attempt every cleanup, even after a synchronous throw. */
export async function withCleanup<T>(
  operation: () => T | Promise<T>,
  cleanups: (() => unknown)[],
): Promise<T> {
  const [outcome] = await Promise.allSettled([
    Promise.resolve().then(operation),
  ]);
  const cleanupResults = await Promise.allSettled(
    cleanups.map((cleanup) => Promise.resolve().then(cleanup)),
  );
  const failures: unknown[] =
    outcome.status === 'rejected' ? [outcome.reason] : [];
  for (const result of cleanupResults) {
    if (result.status === 'rejected') failures.push(result.reason);
  }
  if (failures.length > 1) {
    throw new AggregateError(
      failures,
      failures
        .map((failure) =>
          failure instanceof Error ? failure.message : String(failure),
        )
        .join('\n'),
      { cause: failures[0] },
    );
  }
  if (outcome.status === 'rejected') throw outcome.reason;
  if (failures.length) throw failures[0];
  return outcome.value;
}

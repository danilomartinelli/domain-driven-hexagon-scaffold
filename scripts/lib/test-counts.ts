export interface TestCounts {
  pass: number;
  fail: number;
}

/** Counts from the last `bun test` summary; agent mode keeps these lines. */
export function bunTestCounts(output: string): TestCounts | undefined {
  const text = Bun.stripANSI(output);
  const last = (label: string) =>
    [...text.matchAll(new RegExp(`^\\s*(\\d+) ${label}\\s*$`, 'gm'))].at(-1);
  const pass = last('pass');
  const fail = last('fail');
  if (!pass || !fail) return undefined;
  return { pass: Number(pass[1]), fail: Number(fail[1]) };
}

/** The result-line fragment for counts, empty for commands that are not tests. */
export function describeCounts(counts: TestCounts | undefined): string {
  return counts
    ? `bun test ${String(counts.pass)} pass, ${String(counts.fail)} fail; `
    : '';
}

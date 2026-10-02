/** Repeat bounded diagnostic context after verbose container cleanup output. */
export function failureExcerpt(output: string): string {
  const lines = Bun.stripANSI(output).trimEnd().split('\n');
  const selected = new Set<number>();
  let failures = 0;
  for (const [index, line] of lines.entries()) {
    if (!/^(?:\(fail\)|✗|error:|\w+Error:)/.test(line)) continue;
    for (
      let context = Math.max(0, index - 10);
      context <= Math.min(lines.length - 1, index + 20);
      context++
    )
      selected.add(context);
    if (++failures === 3) break;
  }
  // Non-test commands and interrupted runs may not have Bun failure markers.
  const excerpt = selected.size
    ? [...selected].map((index) => lines[index])
    : lines.slice(-60);
  return excerpt
    .map((line) => line.slice(0, 250))
    .join('\n')
    .slice(0, 16_000);
}

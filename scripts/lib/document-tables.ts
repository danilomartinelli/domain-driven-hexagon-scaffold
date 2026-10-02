/** First-column backticked names of the table under a level-two guide heading. */
export function tableNames(guide: string, heading: string): string[] {
  const section = guide
    .split(/^## /m)
    .find(
      (part) =>
        part.startsWith(`${heading}\n`) || part.startsWith(`${heading}\r\n`),
    );
  if (!section) throw new Error(`Missing section: ${heading}`);
  return section
    .split('\n')
    .filter((line) => line.startsWith('| `'))
    .flatMap((line) =>
      [...(line.split('|')[1] ?? '').matchAll(/`([^`]+)`/g)].map(
        (match) => match[1],
      ),
    );
}

import { open } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { runCommand, type CommandResult } from './command';

export const MAX_SEARCH_BYTES = 1_048_576;

/** Keep batch reads under the same process deadline and output cap as searches. */
export function readRanges(
  args: string[],
  options: Parameters<typeof runCommand>[1],
  resume?: string,
): Promise<CommandResult> {
  return runCommand(
    [
      process.execPath,
      fileURLToPath(import.meta.url),
      String(options.maxOutput ?? 64_000),
      resume ?? '',
      ...args,
    ],
    options,
  );
}

async function printRanges(
  args: string[],
  maxBytes: number,
  resume: string,
): Promise<void> {
  const statusBytes = 160;
  const budget = maxBytes - statusBytes;
  let bytes = 0;
  try {
    if (!args.length || args.length % 3 !== 0)
      throw new Error(
        'Read mode expects <file> <first-line> <last-line> triples.',
      );
    // Validate the entire batch before emitting any content.
    const ranges = Array.from({ length: args.length / 3 }, (_, index) => {
      const [file, first, last] = args.slice(index * 3, index * 3 + 3);
      const start = Number(first);
      const end = Number(last);
      if (
        !/^\d+$/.test(first) ||
        !/^\d+$/.test(last) ||
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start < 1 ||
        end < start
      )
        throw new Error(
          'Line ranges must be positive inclusive integers with first <= last.',
        );
      return { file, start, end };
    });
    let firstRange = 0;
    let firstLine: number | undefined;
    if (resume) {
      const cursor = /^(\d+):(\d+)$/.exec(resume);
      firstRange = Number(cursor?.[1]);
      firstLine = Number(cursor?.[2]);
      const range = ranges.at(firstRange);
      if (
        !Number.isSafeInteger(firstRange) ||
        !Number.isSafeInteger(firstLine) ||
        !range ||
        firstLine < range.start ||
        firstLine > range.end
      )
        throw new Error('Invalid resume cursor for the original ranges');
    }
    for (let index = firstRange; index < ranges.length; index++) {
      const { file, start, end } = ranges[index];
      const selectedStart = index === firstRange ? (firstLine ?? start) : start;
      const handle = await open(file);
      try {
        if (!(await handle.stat()).isFile())
          throw new Error(`Not a regular file: ${file}`);
        const input = handle.createReadStream({ autoClose: false });
        const lines = createInterface({ input, crlfDelay: Infinity });
        try {
          let lineNumber = 0;
          for await (const line of lines) {
            lineNumber++;
            if (lineNumber >= selectedStart) {
              const output = `${file}:${String(lineNumber)}:${line}\n`;
              const size = Buffer.byteLength(output);
              if (bytes + size > budget) {
                if (size + statusBytes > MAX_SEARCH_BYTES) {
                  process.stderr.write(
                    `[search:truncated] Range ${String(index)}, line ${String(lineNumber)} exceeds the maximum ${String(MAX_SEARCH_BYTES)}-byte page. Whole-line continuation is unavailable.\n`,
                  );
                  process.exitCode = 125;
                  return;
                }
                const reason =
                  size > budget
                    ? `Line exceeds page budget; needs --max-bytes=${String(size + statusBytes)}.`
                    : 'Read page full; repeat original ranges with the cursor below.';
                process.stderr.write(
                  `[search:truncated] ${reason}\n[search:resume] --resume=${String(index)}:${String(lineNumber)}\n`,
                );
                process.exitCode = 125;
                return;
              }
              bytes += size;
              process.stdout.write(output);
            }
            if (lineNumber >= end) break;
          }
        } finally {
          lines.close();
          input.destroy();
        }
      } finally {
        await handle.close();
      }
    }
  } catch (error) {
    const message = String(error) + '\n';
    if (Buffer.byteLength(message) > maxBytes - bytes) {
      process.stderr.write(
        '[search:truncated] Read failed; diagnostic exceeds the output budget.\n',
      );
      process.exitCode = 125;
    } else {
      process.stderr.write(message);
      process.exitCode = 2;
    }
  }
}

if (import.meta.main) {
  const maxBytes = Number(process.argv[2]);
  await printRanges(process.argv.slice(4), maxBytes, process.argv[3]);
}

import { open } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { runCommand, type CommandResult } from './command';

/** Keep batch reads under the same process deadline and output cap as searches. */
export function readRanges(
  args: string[],
  options: Parameters<typeof runCommand>[1],
): Promise<CommandResult> {
  return runCommand(
    [
      process.execPath,
      fileURLToPath(import.meta.url),
      String(options.maxOutput ?? 64_000),
      ...args,
    ],
    options,
  );
}

async function printRanges(args: string[], maxBytes: number): Promise<void> {
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
  let bytes = 0;
  for (const { file, start, end } of ranges) {
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
          if (lineNumber >= start) {
            const output = `${file}:${String(lineNumber)}:${line}\n`;
            bytes += Buffer.byteLength(output);
            if (bytes > maxBytes) {
              process.exitCode = 125;
              return;
            }
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
}

if (import.meta.main) {
  const maxBytes = Number(process.argv[2]);
  try {
    await printRanges(process.argv.slice(3), maxBytes);
  } catch (error) {
    const message = String(error);
    if (Buffer.byteLength(message + '\n') > maxBytes) {
      console.error('Read failed; diagnostic exceeds the output budget.');
      process.exitCode = 125;
    } else {
      console.error(message);
      process.exitCode = 2;
    }
  }
}

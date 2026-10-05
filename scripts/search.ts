import { runCommand } from './lib/command';
import { MAX_SEARCH_BYTES, readRanges } from './lib/read-ranges';

const usage = `Usage:
  bun run search [--max-bytes=6000] [--timeout-ms=10000] -- <rg arguments>
  bun scripts/search.ts --read [--resume=<range-index>:<line>] [--max-bytes=6000] [--timeout-ms=10000] -- <file> <first-line> <last-line> ...

Place wrapper options before -- and ripgrep arguments or inclusive file ranges after it.
Exit 125 means output is incomplete; read mode supplies a --resume cursor.
For ripgrep help, use: bun run search -- --help`;

/** Keep complete leading lines within the UTF-8 byte budget. */
function clip(text: string, bytes: number): string {
  if (Buffer.byteLength(text) <= bytes) return text;
  const prefix = new TextDecoder().decode(
    Buffer.from(text).subarray(0, bytes),
    {
      stream: true,
    },
  );
  return prefix.slice(0, prefix.lastIndexOf('\n') + 1);
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const separator = args.indexOf('--');
  const options = separator === -1 ? [] : args.slice(0, separator);
  const query = separator === -1 ? args : args.slice(separator + 1);
  if (
    (separator === -1 && args.length === 1 && args[0] === '--help') ||
    options.includes('--help')
  ) {
    process.stdout.write(`${usage}\n`);
    return 0;
  }
  if (
    separator === -1 &&
    /^--(?:read|resume|max-bytes|timeout-ms)(?:=|$)/.test(args[0] ?? '')
  )
    throw new Error(
      'Wrapper options require -- before the query or file ranges. See --help.',
    );
  let maxBytes = 6_000;
  let timeout = 10_000;
  let read = false;
  let resume: string | undefined;
  for (const option of options) {
    if (option === '--read') {
      read = true;
      continue;
    }
    if (option.startsWith('--resume=')) {
      resume = option.slice('--resume='.length);
      continue;
    }
    const match = /^--(max-bytes|timeout-ms)=(\d+)$/.exec(option);
    if (!match) throw new Error(`Unknown search option: ${option}`);
    const value = Number(match[2]);
    if (match[1] === 'max-bytes') maxBytes = value;
    else timeout = value;
  }
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 256 ||
    maxBytes > MAX_SEARCH_BYTES
  )
    throw new Error(`max-bytes must be 256..${String(MAX_SEARCH_BYTES)}`);
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 60_000)
    throw new Error('timeout-ms must be 1..60000');
  if (resume !== undefined && !read)
    throw new Error('--resume requires --read and the original ranges');
  if (resume !== undefined && !/^\d+:\d+$/.test(resume))
    throw new Error('Invalid resume cursor; expected <range-index>:<line>');
  if (!query.length) throw new Error(usage);
  const limits = {
    cwd: process.cwd(),
    timeout,
    maxOutput: maxBytes,
    outputRetention: 'head' as const,
  };
  const result = read
    ? await readRanges(query, limits, resume)
    : await runCommand(
        [
          'rg',
          '--no-config',
          '--line-number',
          '--color=never',
          '--max-columns=240',
          '--max-columns-preview',
          ...query,
        ],
        limits,
      );
  // Read pages reserve their diagnostic space before emitting lines. Forward them
  // intact so the continuation always follows the last line actually delivered.
  if (
    read &&
    !result.timedOut &&
    Buffer.byteLength(result.stdout + result.stderr) <= maxBytes
  ) {
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    return result.code;
  }
  // Reserve room for the status message inside the combined stream budget.
  const budget = maxBytes - 160;
  const stdout = clip(result.stdout, budget);
  const stderr = clip(result.stderr, budget - Buffer.byteLength(stdout));
  const truncated =
    result.code === 125 || stdout !== result.stdout || stderr !== result.stderr;
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  if (result.timedOut) {
    console.error(
      '\n[search:timeout] Search exceeded its deadline; results are incomplete. Narrow the query.',
    );
    return 124;
  }
  if (truncated) {
    console.error(
      '\n[search:truncated] Output exceeded the byte budget; results are incomplete. Narrow the query.',
    );
    return 125;
  }
  return result.code;
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(String(error));
  process.exitCode = 2;
}

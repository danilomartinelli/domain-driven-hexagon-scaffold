import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runCommand } from './lib/command';
import { MAX_SEARCH_BYTES, readRanges } from './lib/read-ranges';

const statusBytes = 200;
const captureRoot = '.context/codegraph';
const cursorPattern = /^([a-f0-9-]{36}):(\d+):(\d+)$/;

interface Capture {
  code: number;
  timedOut: boolean;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  // Bun consumes a leading separator when the query is the first script argument.
  if (args[0] && !args[0].startsWith('--')) args.unshift('--');
  const separator = args.indexOf('--');
  const options = separator === -1 ? args : args.slice(0, separator);
  const query = separator === -1 ? [] : args.slice(separator + 1);
  let maxBytes = 6_000;
  let maxFiles = 5;
  let timeout = 10_000;
  let resume: string | undefined;
  for (const option of options) {
    if (option.startsWith('--resume=')) {
      resume = option.slice('--resume='.length);
      continue;
    }
    const match = /^--(max-bytes|max-files|timeout-ms)=(\d+)$/.exec(option);
    if (!match) throw new Error('Unknown exploration option');
    const value = Number(match[2]);
    if (match[1] === 'max-bytes') maxBytes = value;
    else if (match[1] === 'max-files') maxFiles = value;
    else timeout = value;
  }
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 512 ||
    maxBytes > MAX_SEARCH_BYTES
  ) {
    throw new Error(`max-bytes must be 512..${String(MAX_SEARCH_BYTES)}`);
  }
  if (!Number.isSafeInteger(maxFiles) || maxFiles < 1 || maxFiles > 20) {
    throw new Error('max-files must be 1..20');
  }
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 60_000) {
    throw new Error('timeout-ms must be 1..60000');
  }
  const cursor = resume === undefined ? undefined : cursorPattern.exec(resume);
  if (resume !== undefined && (!cursor || query.length)) {
    throw new Error(
      'Resume requires --resume=<capture-id>:<range>:<line> without a new query',
    );
  }
  if (resume === undefined && !query.length) {
    throw new Error(
      'Usage: bun scripts/explore.ts [--max-bytes=6000] [--max-files=5] [--timeout-ms=10000] -- <query>',
    );
  }
  const id = cursor?.[1] ?? randomUUID();
  const directory = join(captureRoot, id);
  let capture: Capture;
  if (cursor) {
    capture = JSON.parse(
      await readFile(join(directory, 'result.json'), 'utf8'),
    ) as Capture;
  } else {
    await mkdir(directory, { recursive: true });
    const result = await runCommand(
      [
        'codegraph',
        'explore',
        '--path',
        process.cwd(),
        '--max-files',
        String(maxFiles),
        '--',
        ...query,
      ],
      {
        cwd: process.cwd(),
        timeout,
        maxOutput: 8_000_000,
        outputRetention: 'head',
      },
    );
    capture = { code: result.code, timedOut: result.timedOut };
    await writeFile(join(directory, 'stdout.txt'), result.stdout);
    await writeFile(join(directory, 'stderr.txt'), result.stderr);
    await writeFile(join(directory, 'result.json'), JSON.stringify(capture));
  }

  const page = await readRanges(
    [
      join(directory, 'stdout.txt'),
      '1',
      String(Number.MAX_SAFE_INTEGER),
      join(directory, 'stderr.txt'),
      '1',
      String(Number.MAX_SAFE_INTEGER),
    ],
    {
      cwd: process.cwd(),
      timeout,
      maxOutput: maxBytes - statusBytes,
    },
    cursor ? `${cursor[2]}:${cursor[3]}` : undefined,
    'basename',
  );
  // Reuse the search reader's line/UTF-8 pagination, but bind the cursor to an
  // immutable capture. Reading the next page never reruns CodeGraph.
  let diagnostics = page.stderr
    .replace(
      /\[search:resume\] --resume=(\d+:\d+)/g,
      `[explore:resume] --resume=${id}:$1`,
    )
    .replace(
      /needs --max-bytes=(\d+)/g,
      (_, bytes: string) =>
        `needs --max-bytes=${String(Number(bytes) + statusBytes)}`,
    )
    .replaceAll('[search:', '[explore:')
    .replace('repeat original ranges', 'resume the saved capture');
  const required = /needs --max-bytes=(\d+)/.exec(diagnostics);
  if (required && Number(required[1]) > MAX_SEARCH_BYTES) {
    diagnostics =
      '[explore:truncated] A line exceeds the maximum page budget; inspect the saved capture with a narrower read.\n';
  }
  process.stdout.write(page.stdout);
  process.stderr.write(diagnostics);
  console.error(
    `[explore:capture] ${directory}; command exit ${String(capture.code)}${capture.timedOut ? ' (timeout)' : ''}`,
  );
  if (page.code !== 0) return page.code;
  return capture.code;
}

try {
  process.exitCode = await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(
    new TextDecoder().decode(Buffer.from(message).subarray(0, 256), {
      stream: true,
    }),
  );
  process.exitCode = 2;
}

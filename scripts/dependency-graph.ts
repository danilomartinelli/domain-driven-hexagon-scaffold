import { constants } from 'node:fs';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { delimiter, dirname, join, resolve } from 'node:path';
import { runCommand, type CommandResult } from './lib/command';

async function graphviz(): Promise<string> {
  const configured = process.env.GRAPHVIZ_DOT;
  const candidates = configured
    ? [resolve(configured)]
    : (process.env.PATH ?? '')
        .split(delimiter)
        .map((directory) => resolve(directory || '.', 'dot'));
  for (const candidate of new Set(candidates)) {
    try {
      await access(candidate, constants.X_OK);
    } catch {
      continue;
    }
    const version = await runCommand([candidate, '-V'], {
      cwd: process.cwd(),
      timeout: 2_000,
      maxOutput: 4_000,
    });
    if (
      version.code === 0 &&
      /\bgraphviz version\b/i.test(version.stdout + version.stderr)
    ) {
      return candidate;
    }
  }
  throw new Error(
    'Graphviz dot was not found. Install Graphviz or set GRAPHVIZ_DOT to its executable path.',
  );
}

function failed(stage: string, result: CommandResult): number {
  console.error(
    `[deps:graph] ${stage} failed (exit ${String(result.code)}). ${result.stderr}`,
  );
  return result.code;
}

async function main(): Promise<number> {
  const dot = await graphviz();
  const destination = resolve('assets/dependency-graph.svg');
  await mkdir(dirname(destination), { recursive: true });
  // Keep temporary output on the destination filesystem for an atomic rename.
  const temporary = await mkdtemp(
    join(dirname(destination), '.dependency-graph-'),
  );
  try {
    const analyzed = await runCommand(
      [
        process.execPath,
        './node_modules/.bin/depcruise',
        'src',
        '--include-only',
        '^src',
        '--config',
        '.dependency-cruiser.mjs',
        '--output-type',
        'dot',
      ],
      { cwd: process.cwd(), timeout: 30_000, maxOutput: 8_000_000 },
    );
    if (analyzed.code !== 0) return failed('Dependency analysis', analyzed);
    const input = join(temporary, 'graph.dot');
    const output = join(temporary, 'graph.svg');
    await writeFile(input, analyzed.stdout);
    const rendered = await runCommand([dot, '-T', 'svg', '-o', output, input], {
      cwd: process.cwd(),
      timeout: 30_000,
    });
    if (rendered.code !== 0) return failed('Graphviz rendering', rendered);
    if (!/<svg(?:\s|>)/.test(await readFile(output, 'utf8'))) {
      throw new Error(
        'Graphviz did not produce an SVG; the previous graph was preserved.',
      );
    }
    await rename(output, destination);
    console.log(`Dependency graph updated with ${dot}.`);
    return 0;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 2;
}

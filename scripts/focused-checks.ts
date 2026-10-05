import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { changedFiles, isDocumentation } from './lib/changed-files';
import { runCommand } from './lib/command';

/** Nx targets, project dependencies and the shared workspace fixture. */
const nxRunnerInputs =
  /(^|\/)(project|package)\.json$|^nx\.json$|^bun\.lock$|^scripts\/tests\/workspace-fixture\.ts$/;
/** Provisioning and cleanup code whose failures component suites cannot show. */
const lifecycleInputs =
  /^scripts\/lib\/(environments|compose|gateway|session)\.ts$|^scripts\/(environment-cli|with-test-database)\.ts$|^database\/environment\.ts$|^docker\//;
const lintable = /\.(ts|mjs)$/;

/** Projects affected by the files that define the given target. */
async function affected(files: string[], target: string): Promise<string[]> {
  const result = await runCommand(
    [
      process.execPath,
      '--no-env-file',
      'run',
      'nx',
      'show',
      'projects',
      '--affected',
      `--files=${files.join(',')}`,
      `--with-target=${target}`,
      '--json',
    ],
    { cwd: process.cwd(), timeout: 60_000 },
  );
  if (result.code !== 0)
    throw new Error(result.stderr || 'Nx affected selection failed.');
  return z.array(z.string()).parse(JSON.parse(result.stdout)).sort();
}

/** Print the focused checks that docs/developer-checks.md requires before staged review. */
async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: { base: { type: 'string' }, head: { type: 'string' } },
  });
  const changed = await changedFiles(values);
  if (!changed) throw new Error('A comparison base is required.');
  const runtime = changed.filter((file) => !isDocumentation(file));
  if (!runtime.length) {
    console.log(
      changed.length
        ? '[focused:docs] Format the changed documents, run `bun run check:docs` and verify changed commands.'
        : '[focused:none] No changes.',
    );
    return;
  }
  const printRequired = (command: string, reason: string) => {
    console.log(`[focused:required] ${command}  # ${reason}`);
  };
  const paths = runtime.filter(
    (file) => lintable.test(file) && existsSync(file),
  );
  if (paths.length)
    printRequired(
      `bun --bun eslint ${paths.join(' ')} --max-warnings 0`,
      'changed TypeScript/JavaScript paths',
    );
  for (const target of ['typecheck', 'test']) {
    const projects = await affected(runtime, target);
    if (projects.length)
      printRequired(
        `bun run nx run-many --projects=${projects.join(',')} --target=${target}`,
        `affected ${target} targets`,
      );
  }
  for (const file of runtime.filter(
    (path) => path.endsWith('project.json') && existsSync(path),
  )) {
    const { name } = z
      .object({ name: z.string() })
      .parse(await Bun.file(file).json());
    printRequired(
      `bun run nx run ${name}:<changed-target> --skip-nx-cache`,
      `${file} changed; run each changed target uncached`,
    );
  }
  if (runtime.some((file) => nxRunnerInputs.test(file)))
    printRequired(
      'bun run nx run test-runner:test-nx-runner',
      'Nx targets, project dependencies or the shared workspace fixture changed',
    );
  if (runtime.some((file) => lifecycleInputs.test(file))) {
    printRequired(
      'bun run nx run test-runner:test-broker',
      'provisioning or cleanup changed; also run the changed lifecycle tests by name',
    );
    printRequired(
      'bun run nx run test-runner:test-gateway',
      'provisioning or cleanup changed',
    );
  }
  for (const project of await affected(runtime, 'test-component'))
    printRequired(
      `bun run nx run ${project}:test-component`,
      'affected component suite',
    );
  printRequired(
    'bun run nx run test-runner:test-preservation',
    'runtime, E2E or runner files changed',
  );
}

try {
  await main();
} catch (error) {
  console.error(
    `[focused:error] ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}

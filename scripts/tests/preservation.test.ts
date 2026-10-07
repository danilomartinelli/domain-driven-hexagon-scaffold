import { expect, test } from 'bun:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  commitBaseline,
  createWorkspace,
  isolatedEnvironment,
} from './workspace-fixture';
import { runCommand } from '../lib/command';
import { z } from 'zod';

test('the uncached preservation scenario remains covered by the local lifecycle gate', async () => {
  const project = z
    .object({
      targets: z.record(
        z.string(),
        z
          .object({
            cache: z.boolean().optional(),
            options: z.object({ command: z.string() }).loose(),
          })
          .loose(),
      ),
    })
    .parse(await Bun.file(new URL('../project.json', import.meta.url)).json());
  expect(project.targets['test-preservation'].cache).toBe(false);
  expect(project.targets['test-preservation'].options.command).toContain(
    'prepared regression runs reject foreign targets and preserve development and sibling data',
  );
  expect(project.targets['test-live'].cache).toBe(false);
  expect(project.targets['test-live'].options.command).toContain(
    './scripts/tests/environment.test.ts',
  );
  expect(project.targets['test-live'].options.command).not.toContain(
    '--test-name-pattern',
  );
  const { scripts } = z
    .object({ scripts: z.record(z.string(), z.string()) })
    .parse(
      await Bun.file(new URL('../../package.json', import.meta.url)).json(),
    );
  expect(scripts['check:full']).toContain('bun run test:tooling');
  expect(scripts['test:tooling']).toBe('bun run nx run test-runner:test-live');
});

test('preservation selection includes staged, unstaged and new runtime files, but skips documentation', async () => {
  const workspace = await createWorkspace();
  const output = join(workspace.root, '.git/ci-output');
  const execute = (args: string[]) =>
    runCommand(args, {
      cwd: workspace.root,
      env: { ...isolatedEnvironment(), GITHUB_OUTPUT: output },
    });
  const run = async (...args: string[]) => {
    const result = await execute(args);
    expect(result.code, result.stdout + result.stderr).toBe(0);
    return result.stdout;
  };
  try {
    await commitBaseline(workspace);
    const select = () =>
      run(process.execPath, 'scripts/preservation-required.ts');
    expect(await select()).toContain('[preservation:skipped]');
    await writeFile(
      join(workspace.root, 'README.md'),
      'Updated documentation.',
    );
    expect(await select()).toContain('[preservation:skipped]');
    await writeFile(
      join(workspace.root, 'scripts/new runtime.ts'),
      'export {};',
    );
    expect(await select()).toContain('scripts/new runtime.ts');
    await run('git', 'add', 'scripts/new runtime.ts');
    expect(await select()).toContain('[preservation:required]');
    await run('git', 'reset', '--hard', 'HEAD');
    await writeFile(
      join(workspace.root, 'tests/setup/service-process.ts'),
      'export {};',
    );
    expect(await select()).toContain('tests/setup/service-process.ts');
    await run('git', 'add', 'tests/setup/service-process.ts');
    await run(
      'git',
      'restore',
      '--source=HEAD',
      '--worktree',
      'tests/setup/service-process.ts',
    );
    expect(await select()).toContain('[preservation:required]');
    const immutable = await run(
      process.execPath,
      'scripts/preservation-required.ts',
      '--head=HEAD',
    );
    expect(immutable).toContain('[preservation:skipped]');
    await run(
      'git',
      'mv',
      'tests/setup/service-process.ts',
      'tests/setup/renamed.md',
    );
    expect(await select()).toContain('tests/setup/service-process.ts');
    expect(
      await run(
        process.execPath,
        'scripts/preservation-required.ts',
        '--base=',
        '--head=HEAD',
      ),
    ).toContain('[preservation:required]');
    const invalid = await execute([
      process.execPath,
      'scripts/preservation-required.ts',
      '--base=missing-ref',
    ]);
    expect(invalid.code).not.toBe(0);
    expect(invalid.stdout).not.toContain('[preservation:skipped]');
    const outputs = await readFile(output, 'utf8');
    expect(outputs).toContain('required=false\n');
    expect(outputs).toContain('required=true\n');
  } finally {
    await workspace.cleanup();
  }
}, 30_000);

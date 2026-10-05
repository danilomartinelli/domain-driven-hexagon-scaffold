import { expect, test } from 'bun:test';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { commitBaseline, createWorkspace } from './workspace-fixture';

const required = '[focused:required] ';

test('focused check selection follows the changed runtime, Nx and lifecycle files', async () => {
  const workspace = await createWorkspace();
  const run = async (...args: string[]) => {
    const result = await workspace.run(args, { timeout: 200_000 });
    expect(result.code, result.stdout + result.stderr).toBe(0);
    return result.stdout;
  };
  const select = () =>
    run(process.execPath, '--no-env-file', 'scripts/focused-checks.ts');
  const requiredCommands = async () =>
    (await select())
      .split('\n')
      .filter((line) => line.startsWith(required))
      .map((line) => line.slice(required.length).split('  # ')[0]);
  try {
    await commitBaseline(workspace);
    expect(await select()).toContain('[focused:none]');
    await writeFile(
      join(workspace.root, 'README.md'),
      'Updated documentation.',
    );
    expect(await select()).toContain('[focused:docs]');

    const compose = join(workspace.root, 'scripts/lib/compose.ts');
    await writeFile(compose, `${await Bun.file(compose).text()}\n`);
    const lifecycle = await requiredCommands();
    expect(lifecycle).toContain(
      'bun --bun eslint scripts/lib/compose.ts --max-warnings 0',
    );
    for (const target of [
      'test-runner:test-broker',
      'test-runner:test-gateway',
      'user:test-component',
      'wallet:test-component',
      'test-runner:test-preservation',
    ])
      expect(lifecycle).toContain(`bun run nx run ${target}`);
    expect(lifecycle).not.toContain(
      'bun run nx run test-runner:test-nx-runner',
    );
    expect(
      lifecycle.find((command) => command.endsWith('--target=typecheck')),
    ).toContain('test-runner');

    await run('git', 'reset', '--hard', 'HEAD');
    const project = join(workspace.root, 'src/apps/wallet/project.json');
    await writeFile(project, `${await Bun.file(project).text()}\n`);
    // A removed source file is selected for suites but cannot be linted.
    await rm(join(workspace.root, 'scripts/tests/tcp-gate.ts'));
    const nx = await requiredCommands();
    expect(nx).toContain('bun run nx run test-runner:test-nx-runner');
    expect(nx).toContain('bun run nx run wallet:test-component');
    expect(nx).toContain(
      'bun run nx run wallet:<changed-target> --skip-nx-cache',
    );
    expect(nx).not.toContain('bun run nx run test-runner:test-broker');
    expect(nx.join('\n')).not.toContain('tcp-gate.ts');
  } finally {
    await workspace.cleanup();
  }
}, 400_000);

import { expect } from 'bun:test';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createWorkspace, type Workspace } from './workspace-fixture';

export async function run(
  workspace: Workspace,
  args: string[],
): Promise<string> {
  const result = await workspace.run(args);
  expect(result.code, result.stdout + result.stderr).toBe(0);
  return result.stdout;
}

export function generate(name: string, ...options: string[]): string[] {
  return [
    'bun',
    'run',
    'nx',
    'generate',
    '@starter/generators:nest-app',
    name,
    '--interactive=false',
    ...options,
  ];
}

export async function appWorkspace(): Promise<Workspace> {
  const workspace = await createWorkspace();
  try {
    await rm(join(workspace.root, 'node_modules'), {
      recursive: true,
      force: true,
    });
    await run(workspace, [
      'bun',
      'install',
      '--frozen-lockfile',
      '--ignore-scripts',
    ]);
    return workspace;
  } catch (error) {
    await workspace.cleanup();
    throw error;
  }
}

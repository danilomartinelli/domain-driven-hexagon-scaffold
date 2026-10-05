import { expect } from 'bun:test';
import { readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createWorkspace, type Workspace } from './workspace-fixture';

export async function run(
  workspace: Workspace,
  args: string[],
  options?: { timeout?: number },
): Promise<string> {
  const result = await workspace.run(args, options);
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

/** Generated files carry the application name, never a raw or mangled placeholder. */
export async function expectRendered(
  root: string,
  name: string,
): Promise<void> {
  const app = join(root, 'src/apps', name);
  expect((await readFile(join(app, 'README.md'), 'utf8')).split('\n')[0]).toBe(
    `# ${name}`,
  );
  const files = (await readdir(app, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
  for (const file of files)
    expect(await readFile(file, 'utf8'), file).not.toMatch(/__[A-Za-z]+__/);
}

/** Edit generated text at a known anchor; template drift fails here, not later. */
export function replaceOnce(source: string, from: string, to: string): string {
  if (!source.includes(from))
    throw new Error(`Generated source lacks: ${from}`);
  return source.replace(from, to);
}

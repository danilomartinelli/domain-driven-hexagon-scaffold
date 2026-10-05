import {
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
} from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { runCommand, type CommandResult } from '../lib/command';
import { withCleanup } from './cleanup';

const sourceRoot = realpathSync(join(import.meta.dir, '../..'));

/** Git hooks export paths for their repository; disposable repositories own theirs. */
export function isolatedEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')),
  );
}

export interface Workspace {
  root: string;
  run: (
    args: string[],
    options?: { timeout?: number },
  ) => Promise<CommandResult>;
  cleanup: () => Promise<void>;
}

function ignoreMissing(error: unknown): undefined {
  if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
    return undefined;
  throw error;
}

/** Only inventory determines durability; selection and shutdown status do not. */
async function hasDurableInventory(root: string): Promise<boolean> {
  const inventory = z.object({
    environment: z.enum(['test', 'development']),
    databases: z.array(z.unknown()),
    broker: z.object({}).optional(),
  });
  try {
    const runs = join(root, '.context/test-runs');
    const entries = await readdir(runs, { withFileTypes: true }).catch(
      ignoreMissing,
    );
    let durable = false;
    for (const entry of entries ?? []) {
      if (!entry.isDirectory()) continue;
      const path = join(runs, entry.name, 'environment.json');
      const info = await lstat(path).catch(ignoreMissing);
      if (!info) continue;
      if (!info.isFile())
        throw new Error('Resource inventory is not a regular file');
      const manifest = inventory.parse(
        JSON.parse(await readFile(path, 'utf8')),
      );
      if (
        manifest.environment === 'development' &&
        (manifest.databases.length > 0 || manifest.broker !== undefined)
      )
        durable = true;
    }
    const nested = join(root, '.context/retained-workspaces');
    const workspaces = await readdir(nested, { withFileTypes: true }).catch(
      ignoreMissing,
    );
    for (const entry of workspaces ?? []) {
      if (
        entry.isDirectory() &&
        (await hasDurableInventory(join(nested, entry.name)))
      )
        durable = true;
    }
    return durable;
  } catch (error) {
    throw new Error(`Cannot inspect resource inventory; retained ${root}`, {
      cause: error,
    });
  }
}

async function preserveDiagnostics(root: string): Promise<void> {
  const runs = join(root, '.context/test-runs');
  if (!existsSync(runs)) return;
  for (const entry of await readdir(runs, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    for (const file of ['run.log', 'result.json']) {
      const source = join(runs, entry.name, file);
      const info = await lstat(source).catch(ignoreMissing);
      if (!info?.isFile()) continue;
      const destination = join(sourceRoot, '.context/test-runs', entry.name);
      await mkdir(destination, { recursive: true, mode: 0o700 });
      await copyFile(source, join(destination, file));
    }
  }
}

/** Copy checked source/configuration; only external installed tools are shared. */
export async function createWorkspace({
  retain = false,
}: { retain?: boolean } = {}): Promise<Workspace> {
  // Resource identity includes this path, so retention cannot relocate it later.
  const directory = join(sourceRoot, '.context/retained-workspaces');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(join(directory, 'ddh-workspace-'));
  try {
    const files = await runCommand(
      ['git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'],
      { cwd: sourceRoot, maxOutput: Infinity },
    );
    if (files.code !== 0) throw new Error(files.stderr);
    const roots = new Set([
      'src',
      'scripts',
      'tests',
      'database',
      'docker',
      'tooling',
    ]);
    for (const file of new Set(files.stdout.split('\0').filter(Boolean))) {
      if (file.split('/').some((part) => part.startsWith('.env'))) continue;
      if (
        file.includes('/') &&
        !roots.has(file.split('/')[0]) &&
        file !== 'docs/distribution.md'
      )
        continue;
      const destination = join(root, file);
      await mkdir(dirname(destination), { recursive: true });
      const source = join(sourceRoot, file);
      // Git still lists files deleted in the worktree until they are staged.
      if (await Bun.file(source).exists()) await cp(source, destination);
    }
    const modules = join(root, 'node_modules');
    await mkdir(modules);
    for (const entry of await readdir(join(sourceRoot, 'node_modules'))) {
      const source = join(sourceRoot, 'node_modules', entry);
      const destination = join(modules, entry);
      if (entry === '@starter') {
        // Keep Bun's relative workspace links pointing at the copied source.
        await cp(source, destination, {
          recursive: true,
          verbatimSymlinks: true,
        });
      } else {
        await symlink(source, destination);
      }
    }
    const packages = join(sourceRoot, 'src/packages');
    if (existsSync(packages)) {
      for (const name of await readdir(packages)) {
        const packageModules = join(packages, name, 'node_modules');
        if (!existsSync(packageModules)) continue;
        await cp(
          packageModules,
          join(root, 'src/packages', name, 'node_modules'),
          {
            recursive: true,
            verbatimSymlinks: true,
          },
        );
      }
    }
    return {
      root,
      run: async (args, { timeout = 30_000 } = {}): Promise<CommandResult> => {
        // Nx 23.2.1 reuses native file hashes by mtime (whole seconds on Unix).
        // These fixtures mutate files between commands, sometimes within one
        // tick. Rehash their bytes while retaining graph and task caches, so
        // cache-invalidation assertions cannot silently read stale source.
        await rm(join(root, '.nx/workspace-data/nx_files.nxt'), {
          force: true,
        });
        return runCommand(args, {
          cwd: root,
          timeout,
          env: {
            ...isolatedEnvironment(),
            NX_SKIP_NX_CACHE: 'false',
            // Nested Nx tasks may inherit forced graph reuse. These fixtures
            // mutate projects and must rebuild the graph after each change.
            NX_FORCE_REUSE_CACHED_GRAPH: 'false',
            NX_CACHE_DIRECTORY: join(root, '.nx/cache'),
            NX_WORKSPACE_DATA_DIRECTORY: join(root, '.nx/workspace-data'),
            NX_TUI: 'false',
          },
        });
      },
      cleanup: async (): Promise<void> => {
        const durable = await withCleanup(
          () => hasDurableInventory(root),
          [
            async () => {
              try {
                await preserveDiagnostics(root);
              } catch (error) {
                throw new Error(`Diagnostic export failed; retained ${root}`, {
                  cause: error,
                });
              }
            },
          ],
        );
        if (retain || durable) {
          // Development volumes outlive shutdown. Keep their inventory and
          // runnable workspace at the same path that defines their identity.
          console.log(`Retained workspace: ${root}`);
        } else {
          await rm(root, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

/** Commit the copied files on `master` and point `origin/master` at that baseline. */
export async function commitBaseline(workspace: Workspace): Promise<void> {
  for (const args of [
    ['git', 'init', '--initial-branch=master'],
    ['git', 'add', '.'],
    [
      'git',
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'user.name=Workspace fixture',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '-m',
      'baseline',
    ],
    ['git', 'update-ref', 'refs/remotes/origin/master', 'HEAD'],
  ]) {
    const result = await workspace.run(args);
    if (result.code !== 0) throw new Error(result.stderr || result.stdout);
  }
}

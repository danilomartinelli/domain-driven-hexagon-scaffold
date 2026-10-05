import {
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
} from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runCommand, type CommandResult } from '../lib/command';

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

async function preserveDiagnostics(root: string): Promise<void> {
  const runs = join(root, '.context/test-runs');
  if (!existsSync(runs)) return;
  for (const entry of await readdir(runs, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    for (const file of ['run.log', 'result.json']) {
      const source = join(runs, entry.name, file);
      const info = await lstat(source).catch((error: unknown) => {
        if (
          error instanceof Error &&
          'code' in error &&
          error.code === 'ENOENT'
        )
          return undefined;
        throw error;
      });
      if (!info?.isFile()) continue;
      const destination = join(sourceRoot, '.context/test-runs', entry.name);
      await mkdir(destination, { recursive: true, mode: 0o700 });
      await copyFile(source, join(destination, file));
    }
  }
}

/** Copy checked source/configuration; only external installed tools are shared. */
export async function createWorkspace(): Promise<Workspace> {
  const root = await mkdtemp(join(tmpdir(), 'ddh-workspace-'));
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
      if (file.includes('/') && !roots.has(file.split('/')[0])) continue;
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
        try {
          await preserveDiagnostics(root);
        } catch (error) {
          throw new Error(`Diagnostic export failed; retained ${root}`, {
            cause: error,
          });
        }
        await rm(root, { recursive: true, force: true });
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

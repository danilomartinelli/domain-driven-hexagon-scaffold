import { cp, mkdir, mkdtemp, readdir, rm, symlink } from 'node:fs/promises';
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
  run: (args: string[]) => Promise<CommandResult>;
  cleanup: () => Promise<void>;
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
      run: (args): Promise<CommandResult> =>
        runCommand(args, {
          cwd: root,
          timeout: 30_000,
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
        }),
      cleanup: (): Promise<void> => rm(root, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

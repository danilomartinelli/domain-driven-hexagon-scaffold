import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { runCommand } from './command';

interface DocumentFiles {
  paths: string[];
  read(path: string): Promise<string>;
  kind(path: string): Promise<'file' | 'directory' | undefined>;
}

/** Read one immutable index tree in hooks, or the current tracked/unignored worktree. */
export async function documentFiles(
  root: string,
  staged: boolean,
): Promise<DocumentFiles> {
  const git = async (...args: string[]) => {
    const result = await runCommand(['git', ...args], {
      cwd: root,
      maxOutput: Infinity,
    });
    if (result.code !== 0) throw new Error(result.stderr);
    return result.stdout;
  };
  if (!staged) {
    const paths = [
      ...new Set(
        (
          await git(
            'ls-files',
            '--cached',
            '--others',
            '--exclude-standard',
            '-z',
          )
        )
          .split('\0')
          .filter(Boolean),
      ),
    ];
    const checkedPath = async (path: string) => {
      const canonical = await realpath(join(root, path));
      const within = relative(root, canonical);
      if (within === '..' || within.startsWith('../') || isAbsolute(within))
        throw new Error('symlink target is outside the repository');
      return canonical;
    };
    return {
      paths,
      read: async (path) => readFile(await checkedPath(path), 'utf8'),
      kind: async (path) => {
        try {
          return (await stat(await checkedPath(path))).isDirectory()
            ? 'directory'
            : 'file';
        } catch (error) {
          if (
            error instanceof Error &&
            'code' in error &&
            error.code === 'ENOENT'
          )
            return undefined;
          throw error;
        }
      },
    };
  }
  const tree = (await git('write-tree')).trim();
  const entries = new Map<string, { mode: string; object: string }>();
  for (const entry of (await git('ls-tree', '-r', '-z', tree))
    .split('\0')
    .filter(Boolean)) {
    const match = /^(\d+) \w+ ([a-f0-9]+)\t([\s\S]+)$/.exec(entry);
    if (!match) throw new Error('Invalid Git tree inventory');
    entries.set(match[3], { mode: match[1], object: match[2] });
  }
  async function resolveEntry(
    path: string,
    visited = new Set<string>(),
  ): Promise<string> {
    if (visited.has(path)) throw new Error('cyclic document symlink');
    visited.add(path);
    const entry = entries.get(path);
    if (entry?.mode !== '120000') return path;
    const link = await git('cat-file', 'blob', entry.object);
    const target = relative(root, resolve(root, dirname(path), link));
    if (target === '..' || target.startsWith('../') || isAbsolute(target))
      throw new Error('symlink target is outside the repository');
    return resolveEntry(target, visited);
  }
  return {
    paths: [...entries.keys()],
    read: async (path) => {
      const entry = entries.get(await resolveEntry(path));
      if (!entry) throw new Error('document does not exist in the index');
      return git('cat-file', 'blob', entry.object);
    },
    kind: async (path) => {
      const resolved = await resolveEntry(path);
      if (!resolved || resolved === '.') return 'directory';
      if (entries.has(resolved)) return 'file';
      return [...entries.keys()].some((file) => file.startsWith(`${resolved}/`))
        ? 'directory'
        : undefined;
    },
  };
}

import { runCommand } from './command';

async function git(...args: string[]): Promise<string> {
  const result = await runCommand(['git', ...args], {
    cwd: process.cwd(),
    maxOutput: Infinity,
  });
  if (result.code !== 0)
    throw new Error(result.stderr || 'Git comparison failed.');
  return result.stdout;
}

/**
 * Files changed since the merge-base with `base`. Without `head`, includes
 * staged, unstaged and untracked files; renames count as both paths. Returns
 * `undefined` when there is no comparison baseline (dispatch or first push).
 */
export async function changedFiles({
  base = 'origin/master',
  head,
}: {
  base?: string;
  head?: string;
}): Promise<string[] | undefined> {
  if (base === '' || /^0+$/.test(base)) return undefined;
  const baseSha = (
    await git('rev-parse', '--verify', '--end-of-options', `${base}^{commit}`)
  ).trim();
  const headSha = (
    await git(
      'rev-parse',
      '--verify',
      '--end-of-options',
      `${head ?? 'HEAD'}^{commit}`,
    )
  ).trim();
  const ancestor = (await git('merge-base', baseSha, headSha)).trim();
  let changed = await git(
    'diff',
    '--name-only',
    '--no-renames',
    '-z',
    ancestor,
    ...(head ? [headSha] : []),
    '--',
  );
  if (!head) {
    changed += await git(
      'diff',
      '--cached',
      '--name-only',
      '--no-renames',
      '-z',
      ancestor,
      '--',
    );
    changed += await git('ls-files', '--others', '--exclude-standard', '-z');
  }
  return [...new Set(changed.split('\0').filter(Boolean))];
}

/** Documentation-only changes use the documentation gate instead of runtime suites. */
export function isDocumentation(file: string): boolean {
  return file.startsWith('docs/') || file.endsWith('.md');
}

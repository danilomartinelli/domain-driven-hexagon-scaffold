import { appendFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { runCommand } from './lib/command';

async function git(...args: string[]): Promise<string> {
  const result = await runCommand(['git', ...args], {
    cwd: process.cwd(),
    maxOutput: Infinity,
  });
  if (result.code !== 0)
    throw new Error(result.stderr || 'Git comparison failed.');
  return result.stdout;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: { base: { type: 'string' }, head: { type: 'string' } },
  });
  const base = values.base ?? 'origin/master';
  let files: string[];
  // Dispatch and the first push have no previous commit. Validate conservatively.
  if (base === '' || /^0+$/.test(base)) files = ['(no comparison baseline)'];
  else {
    const baseSha = (
      await git('rev-parse', '--verify', '--end-of-options', `${base}^{commit}`)
    ).trim();
    const headSha = (
      await git(
        'rev-parse',
        '--verify',
        '--end-of-options',
        `${values.head ?? 'HEAD'}^{commit}`,
      )
    ).trim();
    const ancestor = (await git('merge-base', baseSha, headSha)).trim();
    let changed = await git(
      'diff',
      '--name-only',
      '--no-renames',
      '-z',
      ancestor,
      ...(values.head ? [headSha] : []),
      '--',
    );
    if (!values.head) {
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
    files = [...new Set(changed.split('\0').filter(Boolean))].filter(
      (file) => !file.startsWith('docs/') && !file.endsWith('.md'),
    );
  }
  const required = files.length > 0;
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, `required=${String(required)}\n`);
  console.log(
    required
      ? `[preservation:required] ${JSON.stringify(files)}`
      : '[preservation:skipped] Only documentation changed, or no changes.',
  );
}

try {
  await main();
} catch (error) {
  console.error(
    `[preservation:error] ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}

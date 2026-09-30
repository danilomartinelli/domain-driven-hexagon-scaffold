import { parseArgs } from 'node:util';
import { z } from 'zod';
import { runCommand } from './lib/command';

const reportSchema = z.record(
  z.string(),
  z.array(
    z.object({
      title: z.string(),
      url: z.string(),
      severity: z.string(),
      vulnerable_versions: z.string(),
    }),
  ),
);

function isDependencyFile(path: string): boolean {
  return /(^|\/)(package\.json|bun\.lockb?)$/.test(path);
}

async function git(...args: string[]): Promise<string> {
  const result = await runCommand(['git', ...args], {
    cwd: process.cwd(),
    maxOutput: Infinity,
  });
  if (result.code !== 0)
    throw new Error(result.stderr || 'Git change detection failed.');
  return result.stdout;
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: { staged: { type: 'boolean' }, base: { type: 'string' } },
  });
  if (values.staged && values.base)
    throw new Error('Choose --staged or --base, not both.');
  let changes: string;
  if (values.staged) {
    changes = await git(
      'diff',
      '--cached',
      '--name-only',
      '--no-renames',
      '-z',
    );
  } else {
    const base = (
      await git('merge-base', 'HEAD', values.base ?? 'origin/master')
    ).trim();
    changes = await git(
      'diff',
      '--name-only',
      '--no-renames',
      '-z',
      base,
      '--',
    );
    changes += await git('ls-files', '--others', '--exclude-standard', '-z');
  }
  const dependencies = changes.split('\0').filter(isDependencyFile);
  if (dependencies.length === 0) {
    console.log(
      '[audit:skipped] No changed dependency manifests or Bun lockfiles.',
    );
    return 0;
  }
  if (values.staged) {
    const workingChanges = await git(
      'diff',
      '--name-only',
      '--no-renames',
      '-z',
    );
    const untracked = await git(
      'ls-files',
      '--others',
      '--exclude-standard',
      '-z',
    );
    const unstaged = (workingChanges + untracked)
      .split('\0')
      .filter(isDependencyFile);
    if (unstaged.length > 0) {
      throw new Error(
        'Dependency files differ from the index. Stage or stash those changes before auditing the staged dependencies.',
      );
    }
  }
  console.log(`[audit:running] ${dependencies.join(', ')}`);
  const result = await runCommand([process.execPath, 'audit', '--json'], {
    cwd: process.cwd(),
    timeout: 60_000,
  });
  if (result.timedOut)
    throw new Error('Registry query timed out after 60 seconds.');
  let report: z.infer<typeof reportSchema>;
  try {
    report = reportSchema.parse(JSON.parse(result.stdout));
  } catch {
    throw new Error(
      `Registry query did not return an advisory report. ${result.stderr.trim()}`,
    );
  }
  const advisories = Object.entries(report).flatMap(([name, entries]) =>
    entries.map(
      (entry) => `${name}: ${entry.severity} — ${entry.title} (${entry.url})`,
    ),
  );
  if (advisories.length > 0) {
    console.error(
      `[audit:vulnerable] ${String(advisories.length)} advisory entries.\n${advisories.join('\n')}`,
    );
    return 1;
  }
  if (result.code !== 0)
    throw new Error(
      `Audit failed with status ${String(result.code)}. ${result.stderr.trim()}`,
    );
  console.log(
    '[audit:clean] Registry query completed; no vulnerabilities found.',
  );
  return 0;
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(
    `[audit:unavailable] ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 2;
}

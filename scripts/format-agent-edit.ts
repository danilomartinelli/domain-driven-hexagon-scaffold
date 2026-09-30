import { readFile, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { format, getFileInfo, resolveConfig } from 'prettier';
import { z } from 'zod';

const root = await realpath(resolve(import.meta.dir, '..'));
const eventSchema = z.object({
  hook_event_name: z.literal('PostToolUse'),
  cwd: z.string(),
  tool_name: z.string(),
  tool_input: z.unknown(),
});

function editedPaths(input: unknown): { cwd: string; paths: string[] } {
  const event = eventSchema.parse(input);
  if (event.tool_name === 'Edit' || event.tool_name === 'Write') {
    const edit = z.object({ file_path: z.string() }).parse(event.tool_input);
    return { cwd: event.cwd, paths: [edit.file_path] };
  }
  if (event.tool_name === 'apply_patch') {
    const patch = z.object({ command: z.string() }).parse(event.tool_input);
    const paths = [
      ...patch.command.matchAll(
        /^\*\*\* (?:Add File|Update File|Move to): (.+)$/gm,
      ),
    ].map((match) => match[1]);
    return { cwd: event.cwd, paths };
  }
  return { cwd: event.cwd, paths: [] };
}

function inWorkspace(path: string): boolean {
  const local = relative(root, path);
  return (
    local !== '' &&
    !isAbsolute(local) &&
    local !== '..' &&
    !local.startsWith(`..${sep}`)
  );
}

async function formatFile(candidate: string): Promise<string | undefined> {
  let path: string;
  try {
    path = await realpath(candidate);
  } catch (error) {
    // Deleted files and old names from moves are expected in apply_patch events.
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return;
    throw error;
  }
  if (!inWorkspace(path) || relative(root, path).split(sep).includes('.git'))
    return;
  const info = await getFileInfo(path, {
    ignorePath: resolve(root, '.gitignore'),
  });
  if (info.ignored || !info.inferredParser) return;
  const original = await readFile(path, 'utf8');
  const configuration = await resolveConfig(path, { editorconfig: true });
  const formatted = await format(original, {
    ...configuration,
    filepath: path,
  });
  if (formatted === original) return;
  if ((await readFile(path, 'utf8')) !== original) {
    throw new Error(`File changed while formatting: ${relative(root, path)}`);
  }
  await writeFile(path, formatted);
  return relative(root, path);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const direct = args.length === 2 && args[0] === '--file';
  if (args.length && !direct)
    throw new Error('Usage: format-agent-edit.ts [--file <path>]');
  const request = direct
    ? { cwd: process.cwd(), paths: [args[1]] }
    : editedPaths(JSON.parse(await Bun.stdin.text()) as unknown);
  const changed: string[] = [];
  for (const path of new Set(request.paths)) {
    const formatted = await formatFile(resolve(request.cwd, path));
    if (formatted) changed.push(formatted);
  }
  if (changed.length && !direct) {
    console.log(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          additionalContext: `Prettier formatted: ${changed.join(', ')}. Read the resulting files before further edits or review.`,
        },
      }),
    );
  }
}

if (import.meta.main) {
  await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

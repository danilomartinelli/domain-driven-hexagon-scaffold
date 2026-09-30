import { expect, test } from 'bun:test';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runCommand } from '../lib/command';
import { createWorkspace, type Workspace } from './workspace-fixture';

async function hook(
  workspace: Workspace,
  event: unknown,
): ReturnType<typeof runCommand> {
  const eventPath = join(workspace.root, 'hook-event.json');
  await writeFile(eventPath, JSON.stringify(event));
  return workspace.run([
    'sh',
    '-c',
    'exec "$1" --no-env-file scripts/format-agent-edit.ts < "$2"',
    'hook-test',
    process.execPath,
    eventPath,
  ]);
}

test('Claude and Codex format only edited files, including moves and literal shell characters', async () => {
  const workspace = await createWorkspace();
  try {
    const literal = 'scripts/a $(touch injected) [name].ts';
    const original = 'export const value={name:"before"}';
    await writeFile(join(workspace.root, literal), original);
    await writeFile(join(workspace.root, 'scripts/unrelated.ts'), original);
    const claude = await hook(workspace, {
      hook_event_name: 'PostToolUse',
      cwd: workspace.root,
      tool_name: 'Write',
      tool_input: { file_path: join(workspace.root, literal) },
    });
    expect(claude.code, claude.stderr).toBe(0);
    expect(await readFile(join(workspace.root, literal), 'utf8')).toBe(
      "export const value = { name: 'before' };\n",
    );
    expect(
      await readFile(join(workspace.root, 'scripts/unrelated.ts'), 'utf8'),
    ).toBe(original);
    expect(await Bun.file(join(workspace.root, 'injected')).exists()).toBe(
      false,
    );
    await writeFile(join(workspace.root, 'scripts/moved.ts'), original);
    await writeFile(join(workspace.root, 'scripts/added.ts'), original);
    const codex = await hook(workspace, {
      hook_event_name: 'PostToolUse',
      cwd: join(workspace.root, 'scripts'),
      tool_name: 'apply_patch',
      tool_input: {
        command:
          '*** Begin Patch\n*** Update File: old.ts\n*** Move to: moved.ts\n@@\n-a\n+b\n*** Add File: added.ts\n+export const value={name:"before"}\n*** Delete File: deleted.ts\n*** End Patch',
      },
    });
    expect(codex.code, codex.stderr).toBe(0);
    for (const name of ['moved.ts', 'added.ts']) {
      expect(
        await readFile(join(workspace.root, 'scripts', name), 'utf8'),
      ).toBe("export const value = { name: 'before' };\n");
    }
    expect(
      await readFile(join(workspace.root, 'scripts/unrelated.ts'), 'utf8'),
    ).toBe(original);
    expect(codex.stdout).toContain('PostToolUse');
  } finally {
    await workspace.cleanup();
  }
});

test('formatting preserves ignored files, external symlink targets and unsupported tools, and reports syntax errors', async () => {
  const workspace = await createWorkspace();
  const external = await createWorkspace();
  try {
    const original = 'export const value={name:"before"}';
    const outside = join(external.root, 'scripts/outside.ts');
    await writeFile(outside, original);
    await symlink(outside, join(workspace.root, 'scripts/external.ts'));
    await mkdir(join(workspace.root, '.context'));
    const ignored = join(workspace.root, '.context/ignored.ts');
    await writeFile(ignored, original);
    for (const file of [outside, ignored, 'scripts/external.ts']) {
      const result = await workspace.run([
        process.execPath,
        'scripts/format-agent-edit.ts',
        '--file',
        file,
      ]);
      expect(result.code, result.stderr).toBe(0);
    }
    expect(await readFile(outside, 'utf8')).toBe(original);
    expect(await readFile(ignored, 'utf8')).toBe(original);
    const unrelated = join(workspace.root, 'scripts/unrelated.ts');
    await writeFile(unrelated, original);
    const read = await hook(workspace, {
      hook_event_name: 'PostToolUse',
      cwd: workspace.root,
      tool_name: 'Read',
      tool_input: { file_path: unrelated },
    });
    expect(read.code, read.stderr).toBe(0);
    expect(await readFile(unrelated, 'utf8')).toBe(original);
    const invalid = join(workspace.root, 'scripts/invalid.ts');
    await writeFile(invalid, 'export const = ;');
    const failure = await workspace.run([
      process.execPath,
      'scripts/format-agent-edit.ts',
      '--file',
      invalid,
    ]);
    expect(failure.code).toBe(1);
    expect(failure.stderr).not.toBe('');
    expect(await readFile(invalid, 'utf8')).toBe('export const = ;');
  } finally {
    await workspace.cleanup();
    await external.cleanup();
  }
});

test('TypeScript queries resolve workspace exports and references across application and package scopes', async () => {
  const workspace = await createWorkspace();
  try {
    await writeFile(
      join(workspace.root, 'src/navigation-example.ts'),
      "import { navigationValue } from '@starter/core/guard';\nexport const copied = navigationValue;\n",
    );
    await writeFile(
      join(workspace.root, 'src/packages/core/guard.ts'),
      'export const navigationValue = 42;\n',
    );
    const query = (...args: string[]) =>
      workspace.run([process.execPath, 'scripts/typescript-query.ts', ...args]);
    const definition = await query(
      'definition',
      'src/navigation-example.ts',
      '2',
      '24',
    );
    expect(definition.code, definition.stderr).toBe(0);
    expect(definition.stdout).toContain('src/packages/core/guard.ts');
    const references = await query(
      'references',
      'src/packages/core/guard.ts',
      '1',
      '15',
    );
    expect(references.code, references.stderr).toBe(0);
    expect(references.stdout).toContain('src/navigation-example.ts');
    const invalid = await query(
      'definition',
      'src/navigation-example.ts',
      '999',
      '1',
    );
    expect(invalid.code).toBe(1);
    expect(invalid.stderr).toContain('outside the requested line');
  } finally {
    await workspace.cleanup();
  }
}, 30_000);

test('TypeScript queries navigate imported files outside tsconfig roots and reject files outside the program', async () => {
  const workspace = await createWorkspace();
  try {
    await writeFile(
      join(workspace.root, 'database/navigation-imported.ts'),
      'export const navigationValue = 42;\n',
    );
    await writeFile(
      join(workspace.root, 'scripts/navigation-consumer.ts'),
      "import { navigationValue } from '../database/navigation-imported';\nexport const copied = navigationValue;\n",
    );
    await writeFile(
      join(workspace.root, 'database/navigation-unimported.ts'),
      'export const unimportedValue = 42;\n',
    );
    const query = (...args: string[]) =>
      workspace.run([process.execPath, 'scripts/typescript-query.ts', ...args]);
    const definition = await query(
      'definition',
      'scripts/navigation-consumer.ts',
      '2',
      '24',
    );
    expect(definition.code, definition.stderr).toBe(0);
    expect(definition.stdout).toContain('database/navigation-imported.ts');
    const references = await query(
      'references',
      'database/navigation-imported.ts',
      '1',
      '15',
    );
    expect(references.code, references.stderr).toBe(0);
    expect(references.stdout).toContain('scripts/navigation-consumer.ts');
    const unimported = await query(
      'references',
      'database/navigation-unimported.ts',
      '1',
      '15',
    );
    expect(unimported.code).toBe(1);
    expect(unimported.stderr).toContain(
      'File is outside the root TypeScript project',
    );
  } finally {
    await workspace.cleanup();
  }
}, 30_000);

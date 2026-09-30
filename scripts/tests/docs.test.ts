import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommand } from '../lib/command';
import { withCleanup } from './cleanup';
import { isolatedEnvironment } from './workspace-fixture';

const checker = new URL('../check-docs.ts', import.meta.url).pathname;

test('documentation fixtures isolate the calling hook repository', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'starter-docs-hook-'));
  await withCleanup(async () => {
    const initialized = await runCommand(['git', 'init', '-q'], {
      cwd: directory,
      env: isolatedEnvironment(),
    });
    expect(initialized.code, initialized.stderr).toBe(0);
    await writeFile(join(directory, 'sentinel.txt'), 'parent repository');
    const staged = await runCommand(['git', 'add', 'sentinel.txt'], {
      cwd: directory,
      env: isolatedEnvironment(),
    });
    expect(staged.code, staged.stderr).toBe(0);
    const config = join(directory, '.git/config');
    const before = await readFile(config, 'utf8');
    const result = await runCommand(
      [
        process.execPath,
        'test',
        import.meta.path,
        '--test-name-pattern',
        '^a heading change',
      ],
      {
        cwd: directory,
        env: {
          ...isolatedEnvironment(),
          GIT_DIR: join(directory, '.git'),
          GIT_INDEX_FILE: join(directory, '.git/index'),
        },
      },
    );
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(await readFile(config, 'utf8')).toBe(before);
    const files = await runCommand(['git', 'ls-files'], {
      cwd: directory,
      env: isolatedEnvironment(),
    });
    expect(files.code, files.stderr).toBe(0);
    expect(files.stdout).toBe('sentinel.txt\n');
  }, [() => rm(directory, { recursive: true, force: true })]);
});

test('a heading change invalidates inbound links from unchanged documents', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'starter-docs-'));
  const options = { cwd: directory, env: isolatedEnvironment() };
  await withCleanup(async () => {
    await runCommand(['git', 'init', '-q'], options);
    await writeFile(join(directory, 'README.md'), '[setup](guide.md#setup)\n');
    await writeFile(join(directory, 'guide.md'), '# Setup\n');
    await runCommand(['git', 'add', '.'], options);
    const invoke = () => runCommand([process.execPath, checker], options);
    const valid = await invoke();
    expect(valid.code, valid.stdout + valid.stderr).toBe(0);
    await writeFile(join(directory, 'guide.md'), '# Installation\n');
    const invalid = await invoke();
    expect(invalid.code).toBe(1);
    expect(invalid.stderr).toContain('README.md');
    expect(invalid.stderr).toContain('guide.md#setup');
  }, [() => rm(directory, { recursive: true, force: true })]);
});

test('the pre-commit check validates staged documents independently of working copies', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'starter-docs-index-'));
  const options = { cwd: directory, env: isolatedEnvironment() };
  await withCleanup(async () => {
    await runCommand(['git', 'init', '-q'], options);
    await writeFile(join(directory, 'README.md'), '[setup](guide.md#setup)\n');
    await writeFile(join(directory, 'guide.md'), '# Installation\n');
    await runCommand(['git', 'add', '.'], options);
    await writeFile(
      join(directory, 'README.md'),
      '[setup](guide.md#installation)\n',
    );
    const working = await runCommand([process.execPath, checker], options);
    expect(working.code, working.stderr).toBe(0);
    const staged = await runCommand(
      [process.execPath, checker, '--staged'],
      options,
    );
    expect(staged.code, staged.stderr).toBe(1);
    expect(staged.stderr).toContain('guide.md#setup');
    await runCommand(['git', 'add', 'README.md'], options);
    await writeFile(join(directory, 'guide.md'), '# Unstaged heading\n');
    const repaired = await runCommand(
      [process.execPath, checker, '--staged'],
      options,
    );
    expect(repaired.code, repaired.stderr).toBe(0);
  }, [() => rm(directory, { recursive: true, force: true })]);
});

test('Markdown links, images, references and explicit anchors are checked without treating examples as links', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'starter-docs-syntax-'));
  const options = { cwd: directory, env: isolatedEnvironment() };
  await withCleanup(async () => {
    await runCommand(['git', 'init', '-q'], options);
    await writeFile(
      join(directory, 'guide space.md'),
      '# API **setup**\n## Repeat\n## Repeat\n## Configuração\n## <em>Styled</em> heading\n## Fish &amp; chips\n## `A *B* <i>`\n## ![Logo](diagram.svg) Head\n<a id="manual"></a>\n',
    );
    await writeFile(join(directory, 'diagram.svg'), '<svg/>');
    await writeFile(join(directory, 'fish&chips.txt'), 'text');
    await writeFile(
      join(directory, 'README.md'),
      [
        '[setup](<guide space.md#api-setup>)',
        '[again][repeat]',
        '[repeat]: guide%20space.md#repeat-1',
        '[unicode](guide%20space.md#configura%C3%A7%C3%A3o)',
        '[manual](guide%20space.md#manual)',
        '[styled](guide%20space.md#styled-heading)',
        '[entities](guide%20space.md#fish--chips)',
        '[code](guide%20space.md#a-b-i)',
        '[image heading](guide%20space.md#logo-head)',
        '[ampersand path](fish&chips.txt)',
        '![diagram](diagram.svg)',
        '[remote](https://example.invalid/missing)',
        '`[example](missing-inline.md)`',
        '```md',
        '[example](missing-fenced.md)',
        '```',
      ].join('\n\n'),
    );
    await runCommand(['git', 'add', '.'], options);
    const valid = await runCommand([process.execPath, checker], options);
    expect(valid.code, valid.stderr).toBe(0);
    await rm(join(directory, 'diagram.svg'));
    const invalid = await runCommand([process.execPath, checker], options);
    expect(invalid.code).toBe(1);
    expect(invalid.stderr).toContain('diagram.svg: target does not exist');
  }, [() => rm(directory, { recursive: true, force: true })]);
});

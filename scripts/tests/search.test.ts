import { expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommand } from '../lib/command';
import { withCleanup } from './cleanup';

const search = new URL('../search.ts', import.meta.url).pathname;

test('search output is bounded in UTF-8 bytes and marks incomplete results as failure', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'starter-search-'));
  await withCleanup(async () => {
    await writeFile(
      join(directory, 'matches.txt'),
      'needle configuração\n'.repeat(1000),
    );
    const result = await runCommand(
      [process.execPath, search, '--max-bytes=1024', '--', 'needle', '.'],
      { cwd: directory },
    );
    expect(result.code, result.stderr).toBe(125);
    expect(
      Buffer.byteLength(result.stdout + result.stderr),
    ).toBeLessThanOrEqual(1024);
    expect(result.stderr).toContain('search:truncated');
    expect(result.stdout).toContain('matches.txt:');
    expect(result.stdout + result.stderr).not.toContain('\uFFFD');
  }, [() => rm(directory, { recursive: true, force: true })]);
});

test('search previews minified lines and preserves file-list, no-match and error modes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'starter-search-modes-'));
  await withCleanup(async () => {
    await writeFile(
      join(directory, 'bundle.js'),
      'needle' + 'x'.repeat(1_000_000),
    );
    const invoke = (...args: string[]) =>
      runCommand([process.execPath, search, ...args], { cwd: directory });
    const preview = await invoke('needle', '.');
    expect(preview.code, preview.stderr).toBe(0);
    expect(Buffer.byteLength(preview.stdout)).toBeLessThan(512);
    expect(preview.stdout).toContain('bundle.js:1:');
    expect(preview.stdout).toContain('omitted end of long line');
    const files = await invoke('--files', '.');
    expect(files.code).toBe(0);
    expect(files.stdout).toContain('bundle.js');
    expect((await invoke('absent', '.')).code).toBe(1);
    const invalid = await invoke('[');
    expect(invalid.code).toBe(2);
    expect(invalid.stderr).toContain('regex parse error');
  }, [() => rm(directory, { recursive: true, force: true })]);
});

test('a slow ripgrep subprocess is stopped at the search deadline', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'starter-search-timeout-'));
  await withCleanup(async () => {
    const preprocessor = join(directory, 'slow.sh');
    await writeFile(preprocessor, '#!/bin/sh\nsleep 5\ncat "$1"\n', {
      mode: 0o755,
    });
    await writeFile(join(directory, 'input.txt'), 'needle');
    const result = await runCommand(
      [
        process.execPath,
        search,
        '--timeout-ms=100',
        '--',
        '--pre',
        preprocessor,
        'needle',
        'input.txt',
      ],
      { cwd: directory, timeout: 3000 },
    );
    expect(result.code, result.stderr).toBe(124);
    expect(result.stderr).toContain('search:timeout');
    expect(result.timedOut).toBe(false);
  }, [() => rm(directory, { recursive: true, force: true })]);
});

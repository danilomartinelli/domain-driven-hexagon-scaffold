import { expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommand } from '../lib/command';
import { withCleanup } from './cleanup';

const search = new URL('../search.ts', import.meta.url).pathname;

test('read mode returns numbered ranges from a batch in argument order', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'starter-read-ranges-'));
  await withCleanup(async () => {
    await writeFile(
      join(directory, 'first file.txt'),
      'skip\r\nselected\r\nlast\r\n',
    );
    await writeFile(join(directory, 'second.txt'), 'ação\nignore\n');
    const result = await runCommand(
      [
        process.execPath,
        search,
        '--read',
        '--',
        'first file.txt',
        '2',
        '3',
        'second.txt',
        '1',
        '1',
      ],
      { cwd: directory },
    );
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toBe(
      'first file.txt:2:selected\nfirst file.txt:3:last\nsecond.txt:1:ação\n',
    );
    expect(result.stderr).toBe('');
  }, [() => rm(directory, { recursive: true, force: true })]);
});

test('read mode shares one UTF-8 output budget across all ranges', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'starter-read-budget-'));
  await withCleanup(async () => {
    for (const name of ['first.txt', 'second.txt']) {
      await writeFile(join(directory, name), 'marca configuração\n'.repeat(20));
    }
    const result = await runCommand(
      [
        process.execPath,
        search,
        '--read',
        '--max-bytes=1024',
        '--',
        'first.txt',
        '1',
        '20',
        'second.txt',
        '1',
        '20',
      ],
      { cwd: directory },
    );
    expect(result.code, result.stderr).toBe(125);
    expect(
      Buffer.byteLength(result.stdout + result.stderr),
    ).toBeLessThanOrEqual(1024);
    expect(result.stdout).toContain('first.txt:20:marca configuração\n');
    expect(result.stdout).toContain('second.txt:1:marca configuração\n');
    expect(result.stdout).not.toContain('second.txt:20:');
    expect(result.stdout + result.stderr).not.toContain('\uFFFD');
    expect(result.stderr).toContain('search:truncated');
  }, [() => rm(directory, { recursive: true, force: true })]);
});

test('read mode reports missing files and invalid ranges instead of silently skipping them', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'starter-read-errors-'));
  await withCleanup(async () => {
    await writeFile(join(directory, 'present.txt'), 'first\nlast');
    const invoke = (...args: string[]) =>
      runCommand(
        [process.execPath, search, '--read', '--max-bytes=512', '--', ...args],
        { cwd: directory },
      );
    const missing = await invoke(
      'present.txt',
      '1',
      '1',
      'missing.txt',
      '1',
      '1',
    );
    expect(missing.code).toBe(2);
    expect(missing.stdout).toBe('present.txt:1:first\n');
    expect(missing.stderr).toContain('ENOENT');
    expect(
      Buffer.byteLength(missing.stdout + missing.stderr),
    ).toBeLessThanOrEqual(512);
    for (const range of [
      ['0', '1'],
      ['3', '2'],
      ['1.5', '2'],
      ['1', 'Infinity'],
      ['1'],
    ]) {
      const invalid = await invoke(
        'present.txt',
        '1',
        '1',
        'present.txt',
        ...range,
      );
      expect(invalid.code, invalid.stderr).toBe(2);
      expect(invalid.stdout).toBe('');
    }
    // Like sed, the last line is inclusive and an end beyond EOF stops at EOF.
    const eof = await invoke('present.txt', '2', '99');
    expect(eof.code, eof.stderr).toBe(0);
    expect(eof.stdout).toBe('present.txt:2:last\n');
  }, [() => rm(directory, { recursive: true, force: true })]);
});

test('read mode marks an oversized single line as incomplete', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'starter-read-long-line-'));
  await withCleanup(async () => {
    await writeFile(join(directory, 'long.txt'), 'á'.repeat(1_000_000));
    const result = await runCommand(
      [
        process.execPath,
        search,
        '--read',
        '--max-bytes=256',
        '--',
        'long.txt',
        '1',
        '1',
      ],
      { cwd: directory },
    );
    expect(result.code, result.stderr).toBe(125);
    expect(
      Buffer.byteLength(result.stdout + result.stderr),
    ).toBeLessThanOrEqual(256);
    expect(result.stderr).toContain('search:truncated');
    expect(result.stdout + result.stderr).not.toContain('\uFFFD');
  }, [() => rm(directory, { recursive: true, force: true })]);
});

test('read mode bounds diagnostics for oversized invalid file names', async () => {
  const result = await runCommand(
    [
      process.execPath,
      search,
      '--read',
      '--max-bytes=256',
      '--',
      'á'.repeat(1000),
      '1',
      '1',
    ],
    { cwd: process.cwd(), timeout: 3000 },
  );
  expect(result.code, result.stderr).toBe(125);
  expect(Buffer.byteLength(result.stdout + result.stderr)).toBeLessThanOrEqual(
    256,
  );
  expect(result.stderr).toContain('search:truncated');
  expect(result.stdout + result.stderr).not.toContain('\uFFFD');
});

test('a blocked batch read is terminated at the shared deadline', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'starter-read-timeout-'));
  await withCleanup(async () => {
    const pipe = join(directory, 'blocked');
    const setup = await runCommand(['mkfifo', pipe], { cwd: directory });
    expect(setup.code, setup.stderr).toBe(0);
    const result = await runCommand(
      [
        process.execPath,
        search,
        '--read',
        '--timeout-ms=100',
        '--',
        pipe,
        '1',
        '1',
      ],
      { cwd: directory, timeout: 3000 },
    );
    expect(result.code, result.stderr).toBe(124);
    expect(result.stderr).toContain('search:timeout');
    expect(result.timedOut).toBe(false);
  }, [() => rm(directory, { recursive: true, force: true })]);
});

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
    const lines = result.stdout.trimEnd().split('\n');
    expect(lines.length).toBeGreaterThan(1);
    expect(lines).toEqual(
      lines.map(
        (_, index) => `./matches.txt:${String(index + 1)}:needle configuração`,
      ),
    );
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

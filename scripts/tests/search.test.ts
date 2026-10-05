import { expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommand } from '../lib/command';
import { withCleanup } from './cleanup';

const search = new URL('../search.ts', import.meta.url).pathname;

test('wrapper help explains bounded search and read syntax without invoking ripgrep help', async () => {
  const result = await runCommand([process.execPath, search, '--help'], {
    cwd: import.meta.dir,
  });
  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toContain('--read');
  expect(result.stdout).toContain('-- <file> <first-line> <last-line>');
  expect(result.stdout).toContain('-- <rg arguments>');
  expect(result.stderr).toBe('');
  expect(Buffer.byteLength(result.stdout)).toBeLessThan(2_000);
});

test('help after the separator remains a ripgrep argument', async () => {
  const result = await runCommand(
    [process.execPath, search, '--max-bytes=256', '--', '--help'],
    { cwd: import.meta.dir },
  );
  expect(result.code, result.stderr).toBe(125);
  expect(result.stdout).toContain('ripgrep');
  expect(result.stdout).not.toContain('bun run search');
  expect(result.stderr).toContain('[search:truncated]');
});

test('wrapper-looking patterns still work as explicit ripgrep expressions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'starter-search-options-'));
  await withCleanup(async () => {
    await writeFile(join(directory, 'flags.txt'), '--help\n--read\n');
    for (const pattern of ['--help', '--read']) {
      const result = await runCommand(
        [process.execPath, search, '-e', pattern, 'flags.txt'],
        { cwd: directory },
      );
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toContain(pattern);
      expect(result.stdout).not.toContain('Usage:');
    }
  }, [() => rm(directory, { recursive: true, force: true })]);
});

test.each(['--read', '--resume=0:1', '--max-bytes=1000', '--timeout-ms=1000'])(
  'wrapper option %s without a separator explains the required syntax',
  async (option) => {
    const result = await runCommand(
      [process.execPath, search, option, 'file.txt', '1', '2'],
      { cwd: import.meta.dir },
    );
    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Wrapper options require -- before');
    expect(result.stderr).toContain('--help');
    expect(result.stderr).not.toContain('rg:');
  },
);

test.each(['search', 'read'])(
  'the default %s page leaves room for the calling tool envelope',
  async (mode) => {
    const directory = await mkdtemp(join(tmpdir(), 'starter-search-default-'));
    await withCleanup(async () => {
      await writeFile(
        join(directory, 'matches.txt'),
        'match useful content\n'.repeat(400),
      );
      const query =
        mode === 'read'
          ? ['--read', '--', 'matches.txt', '1', '400']
          : ['--', 'match', 'matches.txt'];
      const result = await runCommand([process.execPath, search, ...query], {
        cwd: directory,
      });
      expect(result.code, result.stderr).toBe(125);
      const bytes = Buffer.byteLength(result.stdout + result.stderr);
      expect(bytes).toBeLessThanOrEqual(6_000);
      expect(bytes).toBeGreaterThan(4_000);
      expect(result.stderr).toContain('[search:truncated]');
      if (mode === 'read') expect(result.stderr).toContain('[search:resume]');
    }, [() => rm(directory, { recursive: true, force: true })]);
  },
);

test('search overflow from a quickly exiting producer reports incomplete output without a signal error', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'starter-search-overflow-'));
  await withCleanup(async () => {
    await writeFile(join(directory, 'matches.txt'), 'match\n'.repeat(100));
    // Exercise the exit/output race repeatedly through the real rg subprocess.
    for (let attempt = 0; attempt < 20; attempt++) {
      const result = await runCommand(
        [
          process.execPath,
          search,
          '--max-bytes=256',
          '--',
          'match',
          'matches.txt',
        ],
        { cwd: directory, timeout: 3_000 },
      );
      expect(result.code, result.stderr).toBe(125);
      expect(result.timedOut).toBe(false);
      expect(result.stderr).toContain('[search:truncated]');
      expect(result.stderr).not.toContain('EPERM');
      expect(
        Buffer.byteLength(result.stdout + result.stderr),
      ).toBeLessThanOrEqual(256);
    }
  }, [() => rm(directory, { recursive: true, force: true })]);
}, 70_000);

test.each([256, 512, 1024])(
  'read pages resume without losing or repeating UTF-8 lines across ranges (%i bytes)',
  async (maxBytes) => {
    const directory = await mkdtemp(join(tmpdir(), 'starter-read-pages-'));
    await withCleanup(async () => {
      const file = 'first file:ação.txt';
      const lines = Array.from(
        { length: 35 },
        (_, i) => `linha ${String(i)} ação 🐢`,
      );
      await writeFile(join(directory, file), lines.join('\r\n'));
      await writeFile(join(directory, 'second.txt'), 'fim\n');
      const ranges = [file, '2', '35', 'second.txt', '1', '99', file, '1', '2'];
      let cursor: string[] = [];
      let collected = '';
      for (let page = 0; page < 40; page++) {
        const result = await runCommand(
          [
            process.execPath,
            search,
            '--read',
            `--max-bytes=${String(maxBytes)}`,
            ...cursor,
            '--',
            ...ranges,
          ],
          { cwd: directory },
        );
        expect(
          Buffer.byteLength(result.stdout + result.stderr),
        ).toBeLessThanOrEqual(maxBytes);
        expect(result.stdout).not.toBe('');
        expect(result.stdout + result.stderr).not.toContain('\uFFFD');
        collected += result.stdout;
        if (result.code === 0) {
          expect(collected).toBe(
            [
              ...lines
                .slice(1)
                .map((line, i) => `${file}:${String(i + 2)}:${line}\n`),
              'second.txt:1:fim\n',
              ...lines
                .slice(0, 2)
                .map((line, i) => `${file}:${String(i + 1)}:${line}\n`),
            ].join(''),
          );
          expect(page).toBeGreaterThan(0);
          return;
        }
        expect(result.code, result.stderr).toBe(125);
        const next = /^\[search:resume\] (--resume=\d+:\d+)$/m.exec(
          result.stderr,
        );
        expect(next, result.stderr).not.toBeNull();
        if (!next) throw new Error('Missing read continuation');
        expect(cursor).not.toEqual([next[1]]);
        cursor = [next[1]];
      }
      throw new Error('Read pagination made no progress');
    }, [() => rm(directory, { recursive: true, force: true })]);
  },
);

test('an oversized read line reports the required budget and resumes after delivered lines', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'starter-read-large-page-'));
  await withCleanup(async () => {
    await writeFile(
      join(directory, 'file.txt'),
      `first\n${'á'.repeat(300)}\nlast\n`,
    );
    const invoke = (...options: string[]) =>
      runCommand(
        [
          process.execPath,
          search,
          '--read',
          ...options,
          '--',
          'file.txt',
          '1',
          '3',
        ],
        { cwd: directory },
      );
    const first = await invoke('--max-bytes=256');
    expect(first.code).toBe(125);
    expect(first.stdout).toBe('file.txt:1:first\n');
    expect(first.stderr).toContain('Line exceeds page budget');
    expect(first.stderr).toContain('[search:resume] --resume=0:2');
    const blocked = await invoke('--max-bytes=256', '--resume=0:2');
    expect(blocked.stdout).toBe('');
    expect(blocked.stderr).toContain('Line exceeds page budget');
    expect(Buffer.byteLength(blocked.stderr)).toBeLessThanOrEqual(256);
    const rest = await invoke('--max-bytes=1024', '--resume=0:2');
    expect(rest.code, rest.stderr).toBe(0);
    expect(first.stdout + rest.stdout).toBe(
      `file.txt:1:first\nfile.txt:2:${'á'.repeat(300)}\nfile.txt:3:last\n`,
    );
  }, [() => rm(directory, { recursive: true, force: true })]);
});

test.each(['', '0:0', '1:2', '-1:2', '0:1.5', '0:4', '9007199254740992:2'])(
  'read rejects an invalid cursor %s before emitting content',
  async (cursor) => {
    const result = await runCommand(
      [
        process.execPath,
        search,
        '--read',
        `--resume=${cursor}`,
        '--',
        'package.json',
        '2',
        '3',
      ],
      { cwd: process.cwd() },
    );
    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('cursor');
  },
);

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

test('read mode reports a line above its maximum as terminal without an impossible cursor', async () => {
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
    expect(result.stderr).toContain('exceeds the maximum');
    expect(result.stderr).not.toContain('[search:resume]');
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

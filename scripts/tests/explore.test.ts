import { expect, test } from 'bun:test';
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  realpath,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { createWorkspace } from './workspace-fixture';

test('the default page carries most of its budget as CodeGraph content', async () => {
  const workspace = await createWorkspace();
  try {
    const bin = join(workspace.root, '.context/bin');
    await mkdir(bin, { recursive: true });
    const line = 'a typical CodeGraph output line with useful content';
    const source = `${line}\n`.repeat(400);
    await writeFile(
      join(bin, 'codegraph'),
      `#!/usr/bin/env bun\nprocess.stdout.write(${JSON.stringify(source)});\n`,
      { mode: 0o755 },
    );
    const result = await workspace.run([
      'env',
      `PATH=${bin}:${process.env.PATH ?? ''}`,
      'bun',
      'run',
      'explore',
      '--',
      'a symbol',
    ]);
    expect(result.code, result.stderr).toBe(125);
    expect(
      Buffer.byteLength(result.stdout + result.stderr),
    ).toBeLessThanOrEqual(16_000);
    const lines = result.stdout
      .split('\n')
      .filter((output) => output.endsWith(line));
    expect(lines.length * Buffer.byteLength(`${line}\n`)).toBeGreaterThan(
      12_000,
    );
  } finally {
    await workspace.cleanup();
  }
}, 5_000);

test('CodeGraph pages retain the complete UTF-8 result and resume without executing the query again', async () => {
  const workspace = await createWorkspace();
  try {
    const bin = join(workspace.root, '.context/bin');
    await mkdir(bin, { recursive: true });
    const source = Array.from(
      { length: 300 },
      (_, i) => `symbol ${String(i)}: ação 🐢\n`,
    ).join('');
    const diagnostics = 'CodeGraph diagnostic\n';
    const executable = join(bin, 'codegraph');
    await writeFile(
      executable,
      `#!/usr/bin/env bun
await Bun.write('.context/arguments.json', JSON.stringify(process.argv.slice(2)));
process.stdout.write(${JSON.stringify(source)});
process.stderr.write(${JSON.stringify(diagnostics)});
`,
    );
    await chmod(executable, 0o755);
    const invoke = (...args: string[]) =>
      workspace.run([
        'env',
        `PATH=${bin}:${process.env.PATH ?? ''}`,
        'bun',
        'scripts/explore.ts',
        '--max-bytes=1200',
        ...args,
      ]);
    let result = await invoke(
      '--max-files=2',
      '--',
      'literal $(touch injected)',
    );
    expect(result.code, result.stdout + result.stderr).toBe(125);
    const artifacts = await readdir(join(workspace.root, '.context/codegraph'));
    expect(artifacts).toHaveLength(1);
    const capture = join(workspace.root, '.context/codegraph', artifacts[0]);
    expect(await readFile(join(capture, 'stdout.txt'), 'utf8')).toBe(source);
    expect(await readFile(join(capture, 'stderr.txt'), 'utf8')).toBe(
      diagnostics,
    );
    expect(
      await Bun.file(join(workspace.root, '.context/arguments.json')).json(),
    ).toEqual([
      'explore',
      '--path',
      await realpath(workspace.root),
      '--max-files',
      '2',
      '--',
      'literal $(touch injected)',
    ]);
    expect(await Bun.file(join(workspace.root, 'injected')).exists()).toBe(
      false,
    );
    // Continuations read the saved capture even when the external tool is gone.
    await writeFile(executable, '#!/bin/sh\nexit 99\n');
    let collected = '';
    const cursors = new Set<string>();
    for (let page = 0; page < 150; page++) {
      expect(
        Buffer.byteLength(result.stdout + result.stderr),
      ).toBeLessThanOrEqual(1200);
      expect(result.stdout + result.stderr).not.toContain('\uFFFD');
      collected += result.stdout.replace(/^(stdout|stderr)\.txt:\d+:/gm, '');
      if (result.code === 0) {
        expect(collected).toBe(source + diagnostics);
        return;
      }
      expect(result.code, result.stderr).toBe(125);
      const cursor = /\[explore:resume\] (--resume=[\w:-]+)/.exec(
        result.stderr,
      )?.[1];
      expect(cursor, result.stderr).toBeDefined();
      if (!cursor) throw new Error('Missing continuation');
      expect(cursors.has(cursor)).toBe(false);
      cursors.add(cursor);
      result = await invoke(cursor);
    }
    throw new Error('CodeGraph pagination made no progress');
  } finally {
    await workspace.cleanup();
  }
}, 30_000);

test.each(['failure', 'timeout'])(
  'CodeGraph %s remains a nonzero result inside the page budget',
  async (scenario) => {
    const workspace = await createWorkspace();
    try {
      const bin = join(workspace.root, '.context/bin');
      await mkdir(bin, { recursive: true });
      await writeFile(
        join(bin, 'codegraph'),
        `#!/usr/bin/env bun
console.error('diagnostic from CodeGraph');
${scenario === 'failure' ? 'process.exit(7);' : 'setInterval(() => {}, 1000);'}
`,
        { mode: 0o755 },
      );
      const result = await workspace.run([
        'env',
        `PATH=${bin}:${process.env.PATH ?? ''}`,
        'bun',
        'scripts/explore.ts',
        '--max-bytes=512',
        '--timeout-ms=500',
        '--',
        'a symbol',
      ]);
      expect(result.code, result.stdout + result.stderr).toBe(
        scenario === 'failure' ? 7 : 124,
      );
      expect(result.stdout).toContain('diagnostic from CodeGraph');
      expect(
        Buffer.byteLength(result.stdout + result.stderr),
      ).toBeLessThanOrEqual(512);
      expect(result.stderr).not.toContain('[explore:resume]');
    } finally {
      await workspace.cleanup();
    }
  },
  5_000,
);

test.each([800, 1_048_300])(
  'a %i-byte source line reports a usable budget or an explicit paging limit',
  async (length) => {
    const workspace = await createWorkspace();
    try {
      const bin = join(workspace.root, '.context/bin');
      await mkdir(bin, { recursive: true });
      await writeFile(
        join(bin, 'codegraph'),
        `#!/usr/bin/env bun\nconsole.log('x'.repeat(${String(length)}));\n`,
        { mode: 0o755 },
      );
      const invoke = (...args: string[]) =>
        workspace.run([
          'env',
          `PATH=${bin}:${process.env.PATH ?? ''}`,
          'bun',
          'scripts/explore.ts',
          ...args,
        ]);
      const first = await invoke('--max-bytes=512', '--', 'a symbol');
      expect(first.code, first.stderr).toBe(125);
      expect(
        Buffer.byteLength(first.stdout + first.stderr),
      ).toBeLessThanOrEqual(512);
      if (length > 1_000_000) {
        expect(first.stderr).toContain('maximum page budget');
        expect(first.stderr).not.toContain('[explore:resume]');
      } else {
        const budget = /needs (--max-bytes=\d+)/.exec(first.stderr)?.[1];
        const cursor = /\[explore:resume\] (--resume=[\w:-]+)/.exec(
          first.stderr,
        )?.[1];
        if (!budget || !cursor) throw new Error(first.stderr);
        const next = await invoke(budget, cursor);
        expect(next.code, next.stderr).toBe(0);
        expect(next.stdout).toContain('x'.repeat(length));
        expect(
          Buffer.byteLength(next.stdout + next.stderr),
        ).toBeLessThanOrEqual(Number(budget.split('=')[1]));
      }
    } finally {
      await workspace.cleanup();
    }
  },
  5_000,
);

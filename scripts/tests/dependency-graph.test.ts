import { expect, test } from 'bun:test';
import {
  appendFile,
  chmod,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { createWorkspace } from './workspace-fixture';

const original = '<svg><!-- previously validated graph --></svg>\n';
const rendered = '<svg><!-- new validated graph --></svg>\n';

test.each([
  'wrong executable',
  'analyzer failure',
  'renderer failure',
  'empty renderer output',
  'success',
  'shadowed executable',
])(
  'graph generation preserves the published SVG until success: %s',
  async (scenario) => {
    const workspace = await createWorkspace();
    try {
      const bin = join(workspace.root, '.context/graph tools');
      await mkdir(bin, { recursive: true });
      await mkdir(join(workspace.root, 'assets'));
      const destination = join(workspace.root, 'assets/dependency-graph.svg');
      await writeFile(destination, original);
      const dot = join(bin, 'dot');
      await writeFile(
        dot,
        `#!/usr/bin/env bun
if (process.argv.includes('-V')) {
  console.error(${JSON.stringify(scenario === 'wrong executable' ? 'dotfiles manager' : 'dot - graphviz version test')});
  process.exit(0);
}
const svg = ${JSON.stringify(scenario === 'empty renderer output' ? '' : rendered)};
const output = process.argv.indexOf('-o');
if (output !== -1) await Bun.write(process.argv[output + 1], svg);
else { await Bun.stdin.text(); process.stdout.write(svg); }
process.exit(${scenario === 'renderer failure' ? '7' : '0'});
`,
      );
      await chmod(dot, 0o755);
      const shadow = join(workspace.root, '.context/shadow');
      await mkdir(shadow);
      await writeFile(
        join(shadow, 'dot'),
        '#!/bin/sh\necho "dotfiles manager"\nexit 2\n',
        { mode: 0o755 },
      );
      if (scenario === 'analyzer failure') {
        await appendFile(
          join(workspace.root, '.dependency-cruiser.mjs'),
          '\nthrow new Error("analyzer fixture failed");\n',
        );
      }
      const result = await workspace.run([
        'env',
        '-u',
        'GRAPHVIZ_DOT',
        ...(scenario === 'shadowed executable' ? [] : [`GRAPHVIZ_DOT=${dot}`]),
        `PATH=${shadow}:${bin}:${process.env.PATH ?? ''}`,
        'bun',
        'run',
        'deps:graph',
      ]);
      if (scenario === 'success' || scenario === 'shadowed executable') {
        expect(result.code, result.stdout + result.stderr).toBe(0);
        expect(await readFile(destination, 'utf8')).toBe(rendered);
      } else {
        expect(result.code, result.stdout + result.stderr).not.toBe(0);
        expect(await readFile(destination, 'utf8')).toBe(original);
        if (scenario === 'renderer failure') expect(result.code).toBe(7);
        if (scenario === 'analyzer failure')
          expect(result.stderr).toContain('analyzer fixture failed');
      }
      expect(await readdir(join(workspace.root, 'assets'))).toEqual([
        'dependency-graph.svg',
      ]);
    } finally {
      await workspace.cleanup();
    }
  },
  30_000,
);

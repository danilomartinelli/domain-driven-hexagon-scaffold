import { expect, test } from 'bun:test';
import {
  copyFile,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { z } from 'zod';
import { runCommand } from '../lib/command';
import { createWorkspace, isolatedEnvironment } from './workspace-fixture';

test.each(['new package', 'package-only dependency'])(
  'copied workspaces typecheck with a %s',
  async (scenario) => {
    const source = await createWorkspace();
    try {
      const name = scenario === 'new package' ? 'copied-example' : 'example';
      const packageRoot = join(source.root, 'src/packages', name);
      await mkdir(packageRoot, { recursive: true });
      await writeFile(
        join(packageRoot, 'package.json'),
        JSON.stringify({
          name: `@starter/${name}`,
          exports: { '.': './index.ts' },
          ...(scenario === 'package-only dependency'
            ? { dependencies: { '@fixture/package-only': '1.0.0' } }
            : {}),
        }),
      );
      await writeFile(
        join(packageRoot, 'index.ts'),
        'export const value = 42;\n',
      );
      const packageLink = join(source.root, 'node_modules/@starter', name);
      await rm(packageLink, { force: true });
      await symlink(`../../src/packages/${name}`, packageLink);
      await writeFile(
        join(source.root, 'src/modules/workspace-fixture.ts'),
        `export { value } from '@starter/${name}';\n`,
      );
      if (scenario === 'package-only dependency') {
        // Model Bun's isolated layout: this dependency has no root package link.
        const dependency = join(
          source.root,
          'node_modules/.fixture-store/package-only',
        );
        await mkdir(dependency, { recursive: true });
        await writeFile(
          join(dependency, 'package.json'),
          JSON.stringify({
            name: '@fixture/package-only',
            types: './index.d.ts',
          }),
        );
        await writeFile(
          join(dependency, 'index.d.ts'),
          'export const value: number;\n',
        );
        const scope = join(packageRoot, 'node_modules/@fixture');
        await mkdir(scope, { recursive: true });
        await symlink(relative(scope, dependency), join(scope, 'package-only'));
        await writeFile(
          join(packageRoot, 'index.ts'),
          "export { value } from '@fixture/package-only';\n",
        );
      }
      const initialized = await source.run(['git', 'init', '--quiet']);
      expect(initialized.code, initialized.stderr).toBe(0);
      const typecheck = [
        process.execPath,
        'run',
        'nx',
        'run',
        'legacy-app:typecheck',
        '--output-style=static',
      ];
      const baseline = await source.run(typecheck);
      expect(baseline.code, baseline.stdout + baseline.stderr).toBe(0);
      const originalEntryPoint = await Bun.file(
        join(packageRoot, 'index.ts'),
      ).text();
      const copied = await source.run([
        process.execPath,
        '-e',
        `
        import { strict as assert } from 'node:assert';
        import { appendFile } from 'node:fs/promises';
        import { join } from 'node:path';
        import { createWorkspace } from './scripts/tests/workspace-fixture.ts';
        const workspace = await createWorkspace();
        try {
          const result = await workspace.run(${JSON.stringify(typecheck)});
          assert.equal(result.code, 0, result.stdout + result.stderr);
          await appendFile(
            join(workspace.root, 'src/packages', ${JSON.stringify(name)}, 'index.ts'),
            '\\nexport const copyOnlyInvalid: string = 42;\\n',
          );
          const invalid = await workspace.run(${JSON.stringify(typecheck)});
          assert.notEqual(invalid.code, 0, invalid.stdout + invalid.stderr);
          assert.match(invalid.stdout + invalid.stderr, /TS2322/);
        } finally {
          await workspace.cleanup();
        }
        `,
      ]);
      expect(copied.code, copied.stdout + copied.stderr).toBe(0);
      expect(await Bun.file(join(packageRoot, 'index.ts')).text()).toBe(
        originalEntryPoint,
      );
    } finally {
      await source.cleanup();
    }
  },
  60_000,
);

test('large Git file inventories preserve all workspace source files', async () => {
  const source = await mkdtemp(join(tmpdir(), 'ddh-large-workspace-'));
  const names = Array.from(
    { length: 300 },
    (_, index) => `${String(index).padStart(4, '0')}-${'source'.repeat(36)}.ts`,
  );
  try {
    for (const directory of [
      'scripts/tests',
      'scripts/lib',
      'node_modules',
      'src',
      '.agents',
    ]) {
      await mkdir(join(source, directory), { recursive: true });
    }
    for (const path of [
      'scripts/tests/workspace-fixture.ts',
      'scripts/lib/command.ts',
    ]) {
      await copyFile(join(import.meta.dir, '../..', path), join(source, path));
    }
    for (const directory of ['src', '.agents']) {
      await Promise.all(
        names.map((name) => writeFile(join(source, directory, name), name)),
      );
    }
    const initialized = await runCommand(['git', 'init', '--quiet'], {
      cwd: source,
      env: isolatedEnvironment(),
    });
    expect(initialized.code, initialized.stderr).toBe(0);
    // Load the real helper from a disposable repository so its sourceRoot is isolated.
    const result = await runCommand(
      [
        process.execPath,
        '-e',
        `
        import { strict as assert } from 'node:assert';
        import { readdir } from 'node:fs/promises';
        import { join } from 'node:path';
        import { createWorkspace } from './scripts/tests/workspace-fixture.ts';
        const workspace = await createWorkspace();
        try {
          const expected = await readdir('src');
          assert.deepEqual((await readdir(join(workspace.root, 'src'))).sort(), expected.sort());
          for (const name of expected) {
            assert.equal(await Bun.file(join(workspace.root, 'src', name)).text(), name);
          }
          assert.equal((await readdir(workspace.root)).includes('.agents'), false);
        } finally {
          await workspace.cleanup();
        }
      `,
      ],
      { cwd: source, env: isolatedEnvironment(), timeout: 10_000 },
    );
    expect(result.code, result.stdout + result.stderr).toBe(0);
  } finally {
    await rm(source, { recursive: true, force: true });
  }
}, 30_000);

/** First-column backticked names of the table under a guide heading. */
async function tableNames(heading: string): Promise<string[]> {
  const guide = await Bun.file(
    join(import.meta.dir, '../../docs/nx-workspace.md'),
  ).text();
  const section = guide.split(/^## /m).find((part) => part.startsWith(heading));
  if (!section) throw new Error(`Missing section: ${heading}`);
  return section
    .split('\n')
    .filter((line) => line.startsWith('| `'))
    .flatMap((line) =>
      [...(line.split('|')[1] ?? '').matchAll(/`([^`]+)`/g)].map(
        (match) => match[1],
      ),
    );
}

test('the Nx guide maps every package script that invokes Nx', async () => {
  const { scripts } = z
    .object({ scripts: z.record(z.string(), z.string()) })
    .parse(await Bun.file(join(import.meta.dir, '../../package.json')).json());
  // A documented `*` stands for one script-name segment, as in `migration:*:tests`.
  const documented = (await tableNames('Commands')).map(
    (name) => new RegExp(`^${name.replaceAll('*', '[^:]+')}$`),
  );
  const undocumented = Object.entries(scripts)
    .filter(([, command]) => /\bnx run(-many)?\b/.test(command))
    .map(([name]) => name)
    .filter((name) => !documented.some((pattern) => pattern.test(name)));
  expect(undocumented).toEqual([]);
});

const graphSchema = z.object({
  graph: z.object({
    nodes: z.record(z.string(), z.unknown()),
    dependencies: z.record(
      z.string(),
      z.array(z.object({ target: z.string() })),
    ),
  }),
});

test('Nx discovers source dependencies through the supported Bun entry point', async () => {
  const workspace = await createWorkspace();
  try {
    const result = await workspace.run([
      process.execPath,
      'run',
      'nx',
      'graph',
      '--file=graph.json',
    ]);
    expect(result.code, result.stdout + result.stderr).toBe(0);
    const { graph } = graphSchema.parse(
      await Bun.file(join(workspace.root, 'graph.json')).json(),
    );
    for (const [project, dependencies] of Object.entries({
      'legacy-app': ['core', 'nest-support'],
      wallet: ['core', 'nest-support'],
      'nest-support': ['core'],
      e2e: ['legacy-app', 'test-runner'],
      'test-runner': ['database', 'infrastructure'],
    })) {
      expect(graph.dependencies).toHaveProperty(project);
      for (const dependency of dependencies) {
        expect(
          graph.dependencies[project].map((edge) => edge.target),
          project,
        ).toContain(dependency);
      }
    }
    // The guide's project table stays in step with Nx discovery; this reuses
    // the graph above rather than running Nx in the copied workspace again.
    expect((await tableNames('Projects and ownership')).sort()).toEqual(
      Object.keys(graph.nodes).sort(),
    );
    const targets = (project: string) =>
      graph.dependencies[project].map((edge) => edge.target);
    expect(targets('wallet')).not.toContain('legacy-app');
    expect(targets('legacy-app')).not.toContain('wallet');
    // Shared tooling must not link an application to the transitional one.
    expect(targets('database')).not.toContain('legacy-app');
  } finally {
    await workspace.cleanup();
  }
}, 60_000);

test('cached typechecking is invalidated by dependency source, shared config and the decorator fixture', async () => {
  const workspace = await createWorkspace();
  const typecheck = (): ReturnType<typeof workspace.run> =>
    workspace.run([
      process.execPath,
      'run',
      'nx',
      'run',
      'legacy-app:typecheck',
      '--output-style=static',
    ]);
  try {
    const initial = await typecheck();
    expect(initial.code, initial.stdout + initial.stderr).toBe(0);
    const repeated = await typecheck();
    expect(repeated.code, repeated.stdout + repeated.stderr).toBe(0);
    expect(repeated.stdout).toContain('Nx read the output from the cache');

    const dependency = Bun.file(
      join(workspace.root, 'src/packages/core/errors.ts'),
    );
    const originalSource = await dependency.text();
    await Bun.write(
      dependency,
      originalSource + '\nexport const invalidType: string = 42;\n',
    );
    const sourceFailure = await typecheck();
    expect(sourceFailure.code).not.toBe(0);
    expect(sourceFailure.stdout + sourceFailure.stderr).toContain('TS2322');
    await Bun.write(dependency, originalSource);

    const config = Bun.file(
      join(workspace.root, 'tooling/config/typescript.json'),
    );
    const originalConfig = await config.text();
    const invalidConfig = originalConfig.replace(
      '"ES2022"',
      '"invalid-target"',
    );
    expect(invalidConfig).not.toBe(originalConfig);
    await Bun.write(config, invalidConfig);
    const configFailure = await typecheck();
    expect(configFailure.code).not.toBe(0);
    expect(configFailure.stdout + configFailure.stderr).toContain('TS6046');
    await Bun.write(config, originalConfig);

    const fixture = Bun.file(
      join(workspace.root, 'src/type-tests/final.decorator.ts'),
    );
    const originalFixture = await fixture.text();
    const invalidFixture = originalFixture.replace(
      "staticValue: 'example'",
      "staticValue: 'invalid'",
    );
    expect(invalidFixture).not.toBe(originalFixture);
    await Bun.write(fixture, invalidFixture);
    const fixtureFailure = await typecheck();
    expect(fixtureFailure.code).not.toBe(0);
    expect(fixtureFailure.stdout + fixtureFailure.stderr).toContain('TS2322');
    await Bun.write(fixture, originalFixture);

    const restored = await typecheck();
    expect(restored.code, restored.stdout + restored.stderr).toBe(0);
  } finally {
    await workspace.cleanup();
  }
}, 180_000);

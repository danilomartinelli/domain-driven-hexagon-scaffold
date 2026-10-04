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
import { tableNames as documentedTableNames } from '../lib/document-tables';
import { readProjectGraph } from '../lib/nx-graph';
import { createWorkspace, isolatedEnvironment } from './workspace-fixture';

test.each([
  { noColor: '1', forceColor: undefined, colored: false },
  { noColor: '1', forceColor: '1', colored: false },
  { noColor: undefined, forceColor: '1', colored: true },
])(
  'nested Nx commands honor color preferences without conflicting-variable warnings: %j',
  async ({ noColor, forceColor, colored }) => {
    const workspace = await createWorkspace();
    try {
      const projectPath = join(workspace.root, 'project.json');
      const project = z
        .looseObject({ targets: z.record(z.string(), z.unknown()) })
        .parse(await Bun.file(projectPath).json());
      project.targets['color-outer'] = {
        executor: 'nx:run-commands',
        cache: false,
        options: {
          command:
            'bun run nx run workspace:boundaries --skip-nx-cache --output-style=stream',
        },
      };
      await writeFile(projectPath, JSON.stringify(project));
      const result = await runCommand(
        [
          process.execPath,
          'run',
          'nx',
          'run',
          'workspace:color-outer',
          '--output-style=stream',
        ],
        {
          cwd: workspace.root,
          timeout: 30_000,
          env: {
            ...isolatedEnvironment(),
            NO_COLOR: noColor,
            FORCE_COLOR: forceColor,
            NX_TUI: 'false',
            NX_CACHE_DIRECTORY: join(workspace.root, '.nx/cache'),
            NX_WORKSPACE_DATA_DIRECTORY: join(
              workspace.root,
              '.nx/workspace-data',
            ),
          },
        },
      );
      const output = result.stdout + result.stderr;
      expect(result.code, output).toBe(0);
      expect(output).toContain('Nx project boundaries passed.');
      expect(output).not.toContain("The 'NO_COLOR' env is ignored");
      // Bun echoes the package script to stderr before loading our Nx preload.
      expect(result.stdout.includes('\u001b[')).toBe(colored);
    } finally {
      await workspace.cleanup();
    }
  },
  40_000,
);

test('application debug targets expose two connectable inspectors at the same time', async () => {
  const workspace = await createWorkspace();
  try {
    for (const app of ['user', 'wallet']) {
      await writeFile(
        join(workspace.root, `src/apps/${app}/main.ts`),
        'setInterval(() => {}, 1000);\n',
      );
    }
    const result = await workspace.run([
      process.execPath,
      'scripts/tests/fixtures/debug-inspectors.ts',
    ]);
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain('Connected to both advertised inspectors');
  } finally {
    await workspace.cleanup();
  }
}, 40_000);

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
        join(source.root, 'src/apps/user/workspace-fixture.ts'),
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
        'user:typecheck',
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
  return documentedTableNames(guide, heading);
}

test('application entry point changes select distributed E2E through Nx affected', async () => {
  const workspace = await createWorkspace();
  try {
    for (const app of ['user', 'wallet']) {
      const result = await workspace.run([
        process.execPath,
        'run',
        'nx',
        'show',
        'projects',
        '--affected',
        `--files=src/apps/${app}/main.ts`,
        '--with-target=e2e',
        '--json',
      ]);
      expect(result.code, result.stdout + result.stderr).toBe(0);
      expect(
        z.array(z.string()).parse(JSON.parse(result.stdout)),
        app,
      ).toContain('e2e');
    }
  } finally {
    await workspace.cleanup();
  }
}, 60_000);

test('Nx discovers source dependencies through the supported Bun entry point', async () => {
  const workspace = await createWorkspace();
  try {
    const graph = await readProjectGraph(workspace.root, {
      env: isolatedEnvironment(),
      isolated: true,
    });
    for (const [project, dependencies] of Object.entries({
      'type-fixtures': ['core'],
      wallet: ['core', 'nest-support'],
      user: ['core', 'nest-support', 'integration-contracts'],
      'nest-support': ['core'],
      e2e: ['test-runner', 'user', 'wallet'],
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
    expect(targets('user')).not.toContain('wallet');
    expect(targets('user')).not.toContain('legacy-app');
    expect(targets('wallet')).not.toContain('user');
    // Shared tooling must not link to an application implementation.
    expect(targets('database')).not.toContain('user');
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
      'user:typecheck',
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

test('cached lint and unit tests are invalidated by shared ESLint configuration and project tests', async () => {
  const workspace = await createWorkspace();
  const run = (target: 'lint' | 'test'): ReturnType<typeof workspace.run> =>
    workspace.run([
      process.execPath,
      'run',
      'nx',
      'run',
      `core:${target}`,
      '--output-style=static',
    ]);
  try {
    for (const target of ['lint', 'test'] as const) {
      const initial = await run(target);
      expect(initial.code, initial.stdout + initial.stderr).toBe(0);
      const repeated = await run(target);
      expect(repeated.code, repeated.stdout + repeated.stderr).toBe(0);
      expect(repeated.stdout).toContain('Nx read the output from the cache');
    }

    const config = Bun.file(join(workspace.root, 'tooling/config/eslint.mjs'));
    const originalConfig = await config.text();
    const invalidConfig = originalConfig.replace(
      "{ selector: 'LabeledStatement',",
      "{ selector: 'Program', message: 'Shared lint rule changed' },\n  { selector: 'LabeledStatement',",
    );
    expect(invalidConfig).not.toBe(originalConfig);
    await Bun.write(config, invalidConfig);
    const configFailure = await run('lint');
    expect(configFailure.code).not.toBe(0);
    expect(configFailure.stdout + configFailure.stderr).toContain(
      'Shared lint rule changed',
    );
    await Bun.write(config, originalConfig);

    const probe = join(
      workspace.root,
      'src/packages/core/tests/cache-probe.test.ts',
    );
    await Bun.write(
      probe,
      "import { expect, test } from 'bun:test';\n\ntest('cache probe sees the new test', () => {\n  expect('changed').toBe('cached');\n});\n",
    );
    const testFailure = await run('test');
    expect(testFailure.code).not.toBe(0);
    expect(testFailure.stdout + testFailure.stderr).toContain(
      'cache probe sees the new test',
    );
    await rm(probe);

    for (const target of ['lint', 'test'] as const) {
      const restored = await run(target);
      expect(restored.code, restored.stdout + restored.stderr).toBe(0);
    }
  } finally {
    await workspace.cleanup();
  }
}, 120_000);

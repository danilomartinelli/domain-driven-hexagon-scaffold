import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { z } from 'zod';
import { createWorkspace } from './workspace-fixture';

const graphSchema = z.object({
  graph: z.object({
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

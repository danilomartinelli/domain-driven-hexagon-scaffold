import { expect, test } from 'bun:test';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createWorkspace, type Workspace } from './workspace-fixture';

async function run(workspace: Workspace, args: string[]): Promise<string> {
  const result = await workspace.run(args);
  expect(result.code, result.stdout + result.stderr).toBe(0);
  return result.stdout + result.stderr;
}

async function isolatedWorkspace(): Promise<Workspace> {
  const workspace = await createWorkspace();
  try {
    // Installation must own its store and links, not follow them to the checkout.
    await rm(join(workspace.root, 'node_modules'), {
      recursive: true,
      force: true,
    });
    await run(workspace, ['bun', 'install', '--ignore-scripts']);
    return workspace;
  } catch (error) {
    await workspace.cleanup();
    throw error;
  }
}

function generate(kind: string, name: string, ...options: string[]): string[] {
  return [
    'bun',
    'run',
    'nx',
    'generate',
    `@starter/generators:${kind}`,
    name,
    '--interactive=false',
    ...options,
  ];
}

test('generated libraries are consumable and checked through Nx, Bun and architecture gates', async () => {
  const workspace = await isolatedWorkspace();
  try {
    for (const [kind, name] of [
      ['ts-lib', 'label-core'],
      ['nest-lib', 'label-adapter'],
    ]) {
      const lock = await readFile(join(workspace.root, 'bun.lock'), 'utf8');
      const destinations = await readdir(join(workspace.root, 'src/packages'));
      await run(workspace, generate(kind, name, '--dry-run'));
      expect(await readdir(join(workspace.root, 'src/packages'))).toEqual(
        destinations,
      );
      expect(await readFile(join(workspace.root, 'bun.lock'), 'utf8')).toBe(
        lock,
      );
      await run(workspace, generate(kind, name));
      expect(
        await Bun.file(
          join(workspace.root, `src/packages/${name}/package.json`),
        ).json(),
      ).toMatchObject({
        name: `@starter/${name}`,
        private: true,
        exports: { '.': './index.ts' },
      });
      const noTests = await workspace.run([
        'bun',
        'run',
        'nx',
        'run',
        `${name}:test`,
      ]);
      expect(noTests.code).not.toBe(0);
      expect(noTests.stdout + noTests.stderr).toMatch(
        /No tests found|did not match any test files/,
      );
      expect(
        await readdir(join(workspace.root, `src/packages/${name}/tests`)),
      ).toEqual(['README.md']);
    }
    await run(workspace, [
      'bun',
      'run',
      'nx',
      'run-many',
      '--projects=label-core,label-adapter',
      '--targets=lint,typecheck',
    ]);
    await run(workspace, [
      'bun',
      '--bun',
      'prettier',
      '--check',
      'src/packages/label-{core,adapter}/**/*.{ts,json,md}',
    ]);
    await run(workspace, ['bun', 'run', 'lint:boundaries']);
    const orphan = join(workspace.root, 'src/packages/label-core/unused.ts');
    await writeFile(orphan, 'export {};\n');
    const orphanCheck = await workspace.run(['bun', 'run', 'lint:boundaries']);
    expect(orphanCheck.code).not.toBe(0);
    expect(orphanCheck.stdout + orphanCheck.stderr).toContain('no-orphans');
    await rm(orphan);
    const core = join(workspace.root, 'src/packages/label-core/index.ts');
    const adapter = join(workspace.root, 'src/packages/label-adapter/index.ts');
    await writeFile(
      core,
      'export function normalizeLabel(value: string): string { return value.trim().toLowerCase(); }\n',
    );
    await writeFile(
      adapter,
      "import { Injectable } from '@nestjs/common';\nimport { normalizeLabel } from '@starter/label-core';\n@Injectable()\nexport class LabelAdapter { format(value: string): string { return normalizeLabel(value); } }\n",
    );
    const manifestPath = join(
      workspace.root,
      'src/packages/label-adapter/package.json',
    );
    const manifest = (await Bun.file(manifestPath).json()) as {
      dependencies: Record<string, string>;
    };
    manifest.dependencies['@starter/label-core'] = 'workspace:*';
    await writeFile(manifestPath, JSON.stringify(manifest));
    await run(
      workspace,
      generate(
        'nest-lib',
        'label-composition',
        '--layer=composition',
        '--provider=LabelAdapter',
        '--providerImport=@starter/label-adapter',
      ),
    );
    await writeFile(
      join(workspace.root, 'src/packages/label-core/tests/label.test.ts'),
      "import { expect, test } from 'bun:test';\nimport { normalizeLabel } from '@starter/label-core';\ntest('normalizes a padded mixed-case label', () => { expect(normalizeLabel('  Hello WORLD  ')).toBe('hello world'); });\n",
    );
    await writeFile(
      join(workspace.root, 'src/packages/label-adapter/tests/adapter.test.ts'),
      "import { expect, test } from 'bun:test';\nimport { LabelAdapter } from '@starter/label-adapter';\ntest('adapts label normalization', () => { expect(new LabelAdapter().format('  Label  ')).toBe('label'); });\n",
    );
    await writeFile(
      join(
        workspace.root,
        'src/packages/label-composition/tests/composition.test.ts',
      ),
      "import { expect, test } from 'bun:test';\nimport { NestFactory } from '@nestjs/core';\nimport { LabelCompositionModule } from '@starter/label-composition';\nimport { LabelAdapter } from '@starter/label-adapter';\ntest('provides the selected adapter in a Nest context', async () => { const app = await NestFactory.createApplicationContext(LabelCompositionModule, { logger: false }); try { expect(app.get(LabelAdapter).format('  Hello  ')).toBe('hello'); } finally { await app.close(); } });\n",
    );
    // The existing application core is an appropriate consumer of the generated core.
    await writeFile(
      join(workspace.root, 'src/apps/user/application/generated-label.ts'),
      "export { normalizeLabel } from '@starter/label-core';\n",
    );
    const rootManifestPath = join(workspace.root, 'package.json');
    const rootManifest = (await Bun.file(rootManifestPath).json()) as {
      dependencies: Record<string, string>;
    };
    rootManifest.dependencies['@starter/label-core'] = 'workspace:*';
    await writeFile(rootManifestPath, JSON.stringify(rootManifest));
    await run(workspace, ['bun', 'install', '--ignore-scripts']);
    await run(workspace, [
      'bun',
      '--bun',
      'prettier',
      '--write',
      'src/packages/label-*/**/*.{ts,json,md}',
      'src/apps/user/application/generated-label.ts',
      'package.json',
    ]);
    await run(workspace, [
      'bun',
      'run',
      'nx',
      'run-many',
      '--projects=label-core,label-adapter,label-composition,user',
      '--targets=lint,typecheck,test',
    ]);
    await run(workspace, [
      'bun',
      '--bun',
      'prettier',
      '--check',
      'src/packages/label-*/**/*.{ts,json,md}',
    ]);
    await run(workspace, ['bun', 'run', 'lint:boundaries']);

    // Exercise source-level framework imports and Nx's project dependency check.
    const original = await readFile(core, 'utf8');
    for (const forbidden of [
      "export { Injectable } from '@nestjs/common';\n",
      "export { LabelAdapter } from '@starter/label-adapter';\n",
    ]) {
      await writeFile(core, original + forbidden);
      const rejected = await workspace.run(['bun', 'run', 'lint:boundaries']);
      expect(rejected.code, rejected.stdout + rejected.stderr).not.toBe(0);
      expect(rejected.stdout + rejected.stderr).toContain(
        'core-is-context-independent',
      );
    }
    const nxRejected = await workspace.run([
      'bun',
      'scripts/check-project-boundaries.ts',
    ]);
    expect(nxRejected.code).toBe(1);
    expect(nxRejected.stdout + nxRejected.stderr).toContain(
      'nx-core-is-independent',
    );
    await writeFile(core, original);
    await run(workspace, ['bun', 'run', 'lint:boundaries']);
  } finally {
    await workspace.cleanup();
  }
}, 180_000);

test('invalid presets and collisions leave existing work unchanged', async () => {
  const workspace = await isolatedWorkspace();
  try {
    await mkdir(join(workspace.root, 'src/packages/occupied'));
    const sentinel = join(workspace.root, 'src/packages/occupied/index.ts');
    await writeFile(sentinel, '// existing work\n');
    const lock = await readFile(join(workspace.root, 'bun.lock'), 'utf8');
    for (const args of [
      generate('ts-lib', 'occupied', '--force'),
      generate('nest-lib', 'occupied', '--force'),
      generate('ts-lib', 'user'),
      generate('ts-lib', '../escaped'),
      generate('nest-lib', 'invalid', '--layer=core'),
      generate('nest-lib', 'invalid', '--layer=composition'),
      generate(
        'nest-lib',
        'invalid',
        '--provider=Logger',
        '--providerImport=@nestjs/common',
      ),
      generate(
        'nest-lib',
        'invalid',
        '--layer=composition',
        '--provider=Missing',
        '--providerImport=@starter/core/lib/private',
      ),
    ]) {
      const result = await workspace.run(args);
      expect(result.code, result.stdout + result.stderr).not.toBe(0);
      expect(await readFile(sentinel, 'utf8')).toBe('// existing work\n');
      expect(
        await Bun.file(
          join(workspace.root, 'src/packages/invalid/package.json'),
        ).exists(),
      ).toBe(false);
      expect(await readFile(join(workspace.root, 'bun.lock'), 'utf8')).toBe(
        lock,
      );
    }
  } finally {
    await workspace.cleanup();
  }
}, 90_000);

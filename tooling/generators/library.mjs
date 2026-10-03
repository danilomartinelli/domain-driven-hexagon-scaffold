import { getProjects, installPackagesTask, readJson } from '@nx/devkit';
import { format, resolveConfig } from 'prettier';

/** @typedef {{name: string, layer?: 'core' | 'adapter' | 'composition', provider?: string, providerImport?: string}} LibraryOptions */

/** @param {string} command @param {boolean} [cache] @returns {import('@nx/devkit').TargetConfiguration} */
function target(command, cache = true) {
  return { executor: 'nx:run-commands', cache, options: { command, cwd: '.' } };
}

/** Generate through Nx's virtual tree; installation runs only after the tree is committed.
 * @param {import('@nx/devkit').Tree} tree
 * @param {LibraryOptions} options
 * @param {'core' | 'adapter' | 'composition'} layer
 * @returns {Promise<() => void>}
 */
export async function generateLibrary(tree, options, layer) {
  const { name, provider, providerImport } = options;
  if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(name)) {
    throw new Error('Use a lowercase kebab-case project name, without a path.');
  }
  const root = `src/packages/${name}`;
  const projects = getProjects(tree);
  if (tree.exists(root) || tree.children(root).length || projects.has(name)) {
    throw new Error(`Destination or project already exists: ${root}`);
  }
  /** @type {Record<string, string>} */
  const dependencies = {};
  if (layer !== 'core') {
    const manifest = /** @type {{dependencies: Record<string, string>}} */ (
      readJson(tree, 'package.json')
    );
    dependencies['@nestjs/common'] = manifest.dependencies['@nestjs/common'];
  }
  let source =
    '// Define the public interface here; keep implementation in private subfolders.\nexport {};\n';
  if (layer === 'composition') {
    if (!provider || !/^[A-Z][A-Za-z0-9]*$/.test(provider) || !providerImport) {
      throw new Error(
        'Composition requires --provider and --providerImport for an existing injectable class.',
      );
    }
    const match = /^(@starter\/([a-z][a-z0-9-]*))(\/([a-z][a-z0-9-]*))?$/.exec(
      providerImport,
    );
    if (!match || !tree.exists(`src/packages/${match[2]}/package.json`)) {
      throw new Error(
        'providerImport must be a public src/packages workspace entry point.',
      );
    }
    const manifest = /** @type {{exports?: Record<string, unknown>}} */ (
      readJson(tree, `src/packages/${match[2]}/package.json`)
    );
    if (!manifest.exports?.[match[4] ? `./${match[4]}` : '.']) {
      throw new Error(
        'providerImport must be an explicitly exported workspace entry point.',
      );
    }
    dependencies[match[1]] = 'workspace:*';
    const className =
      name
        .split('-')
        .map((part) => part[0].toUpperCase() + part.slice(1))
        .join('') + 'Module';
    if (className === provider)
      throw new Error('The module and provider must have different names.');
    source = `import { Module } from '@nestjs/common';\nimport { ${provider} } from '${providerImport}';\n\n@Module({ providers: [${provider}], exports: [${provider}] })\n// Nest uses the decorated class as the composition token.\n// eslint-disable-next-line @typescript-eslint/no-extraneous-class\nexport class ${className} {}\n`;
  } else if (provider || providerImport) {
    throw new Error('Provider wiring requires --layer=composition.');
  }
  const packageName = `@starter/${name}`;
  const files = {
    'package.json': JSON.stringify({
      name: packageName,
      version: '0.0.0',
      private: true,
      type: 'module',
      exports: { '.': './index.ts' },
      ...(Object.keys(dependencies).length ? { dependencies } : {}),
    }),
    'project.json': JSON.stringify({
      name,
      projectType: 'library',
      tags: ['scope:shared', `type:${layer}`],
      targets: {
        lint: target(`bun --bun eslint ${root} --max-warnings 0`),
        'lint-fix': target(
          `bun --bun eslint ${root} --max-warnings 0 --fix`,
          false,
        ),
        typecheck: target(`bun --bun tsc --project ${root}/tsconfig.json`),
        test: target(`bun --no-env-file test --cwd ${root} ./tests`),
        'test-watch': target(
          `bun --no-env-file test --cwd ${root} --watch ./tests`,
          false,
        ),
      },
    }),
    'tsconfig.json': JSON.stringify({
      extends: '../../../tsconfig.json',
      include: ['**/*.ts'],
      exclude: ['node_modules'],
    }),
    'bunfig.toml': '[test]\nroot = "./tests"\n',
    'index.ts': source,
    'tests/README.md': `# Tests\n\nNo tests exist yet. Add meaningful native Bun tests of the public \`${packageName}\` entry point here.\n\nRun \`bun run nx run ${name}:test\` from the workspace root. Until tests exist, Bun reports no tests and exits nonzero. No infrastructure or preload is configured.\n`,
    'README.md': `# ${packageName}\n\nPrivate shared technical ${layer} library. Business entities and use cases belong to their application.\n\nThe public entry point is \`${packageName}\`; keep internal implementation in subfolders. Declare \`"${packageName}": "workspace:*"\` in each consumer's dependencies (the root manifest for applications), then run \`bun install\` and repeat the setup checks in the developer guide.\n\nRun \`bun run nx run ${name}:lint\`, \`bun run nx run ${name}:typecheck\` and \`bun run nx run ${name}:test\`. No tests are generated; add behavior and meaningful tests together.\n`,
  };
  const config = await resolveConfig(`${tree.root}/prettier.config.mjs`);
  for (const [path, content] of Object.entries(files)) {
    const filepath = `${root}/${path}`;
    tree.write(
      filepath,
      path.endsWith('.toml')
        ? content
        : await format(content, { ...config, filepath }),
    );
  }
  return () => {
    installPackagesTask(tree, true, '', 'bun');
  };
}

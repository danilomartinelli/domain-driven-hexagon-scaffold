import { getProjects, readJson } from '@nx/devkit';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';

/** @param {string} command @param {boolean} [cache] @returns {import('@nx/devkit').TargetConfiguration} */
function target(command, cache = false) {
  return { executor: 'nx:run-commands', cache, options: { command, cwd: '.' } };
}

/** @param {import('@nx/devkit').Tree} tree
 * @param {{name: string, preset?: string}} options
 */
export default async function nestApp(tree, { name, preset = 'hybrid' }) {
  if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(name))
    throw new Error('Use a lowercase kebab-case project name, without a path.');
  if (preset !== 'hybrid') throw new Error('Supported app preset: hybrid.');
  const root = `src/apps/${name}`;
  if (
    tree.exists(root) ||
    tree.children(root).length ||
    getProjects(tree).has(name)
  )
    throw new Error(`Destination or project already exists: ${root}`);
  const manifest = /** @type {{dependencies: Record<string, string>}} */ (
    readJson(tree, 'package.json')
  );
  const dependencies = Object.fromEntries(
    [
      '@nestjs/apollo',
      '@nestjs/common',
      '@nestjs/core',
      '@nestjs/graphql',
      '@nestjs/platform-express',
      '@apollo/server',
      '@as-integrations/express5',
      '@starter/core',
      '@starter/nest-support',
      '@starter/rabbitmq',
      'amqplib',
      'graphql',
      'reflect-metadata',
      'rxjs',
      'env-var',
      'zod',
    ].map((dependency) => [dependency, manifest.dependencies[dependency]]),
  );
  const unit = `bun --no-env-file test --cwd ${root} ./tests/unit`;
  /** @type {Record<string, string>} */
  const files = {
    'package.json': JSON.stringify({
      name: `@starter/${name}-app`,
      version: '0.0.0',
      private: true,
      exports: {},
      dependencies,
    }),
    'project.json': JSON.stringify({
      name,
      projectType: 'application',
      tags: [`scope:${name}`, 'type:app'],
      implicitDependencies: ['test-runner'],
      targets: {
        lint: target(`bun --bun eslint ${root} --max-warnings 0`, true),
        'lint-fix': target(`bun --bun eslint ${root} --max-warnings 0 --fix`),
        typecheck: target(
          `bun --bun tsc --project ${root}/tsconfig.json`,
          true,
        ),
        test: target(unit, true),
        'test-watch': target(`${unit} --watch`),
        'test-coverage': target(`${unit} --coverage`),
        'test-debug': target(
          `bun --no-env-file --inspect-brk test --cwd ${root} ./tests/unit`,
        ),
        'test-component': target(
          `bun --no-env-file test --cwd ${root} ./tests/component`,
        ),
        serve: target(`bun --no-env-file ${root}/main.ts`),
        watch: target(`bun --no-env-file --watch ${root}/main.ts`),
        debug: target(`bun --no-env-file --inspect ${root}/main.ts`),
        distribution: target(`bun --no-env-file scripts/distribute.ts ${name}`),
      },
    }),
    'tsconfig.json': JSON.stringify({
      extends: '../../../tsconfig.json',
      include: ['**/*.ts'],
      exclude: ['node_modules'],
    }),
    'distribution.json': JSON.stringify(Object.keys(dependencies)),
    'bunfig.toml': '[test]\nroot = "./tests/unit"\n',
    'tests/unit/README.md':
      '# Unit tests\n\nAdd infrastructure-free tests of application behavior here. No tests or placeholder assertions are generated. The test target reports no tests and exits nonzero until behavior is added.\n',
    'tests/component/README.md':
      '# Component tests\n\nAdd process-level HTTP, GraphQL and RabbitMQ tests here. The uncached test-component target selects only this directory and has no unit-test preload. Each live fixture must provision its own broker, assign unique ports and queues, verify ownership before cleanup and close all processes in finally. Never target development or sibling infrastructure. No database or generic User/Wallet environment is selected.\n',
  };
  const templates = fileURLToPath(
    new URL('./nest-app-files/', import.meta.url),
  );
  for (const path of readdirSync(templates, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!path.isFile()) continue;
    const destination = relative(templates, join(path.parentPath, path.name));
    files[destination.replace(/\.template$/, '')] = readFileSync(
      join(path.parentPath, path.name),
      'utf8',
    )
      .replaceAll('__name__', name)
      .replaceAll('__PREFIX__', name.replaceAll('-', '_').toUpperCase());
  }
  const config = await resolveConfig(`${tree.root}/prettier.config.mjs`);
  // Validate and format the complete output before adding any writes to Nx's tree.
  const formatted = await Promise.all(
    Object.entries(files).map(async ([path, content]) => [
      `${root}/${path}`,
      path.endsWith('.toml')
        ? content
        : await format(content, { ...config, filepath: path }),
    ]),
  );
  for (const [path, content] of formatted) tree.write(path, content);
}

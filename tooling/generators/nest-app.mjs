import { getProjects, readJson } from '@nx/devkit';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';

/** @typedef {'persistence' | 'messaging' | 'exposure'} Capability */
/** @type {Capability[]} */
const capabilities = ['persistence', 'messaging', 'exposure'];

/** Packages imported or required at runtime, per enabled capability. */
const runtimeDependencies = {
  base: [
    '@nestjs/common',
    '@nestjs/core',
    '@nestjs/platform-express',
    '@starter/capabilities',
    '@starter/nest-support',
    'reflect-metadata',
    'rxjs',
    'env-var',
  ],
  persistence: ['slonik'],
  messaging: ['@starter/core', '@starter/rabbitmq', 'amqplib', 'zod'],
  exposure: [
    '@nestjs/apollo',
    '@nestjs/graphql',
    '@apollo/server',
    '@as-integrations/express5',
    'graphql',
  ],
};

/** @param {string} command @param {boolean} [cache] @returns {import('@nx/devkit').TargetConfiguration} */
function target(command, cache = false) {
  return { executor: 'nx:run-commands', cache, options: { command, cwd: '.' } };
}

/**
 * Keep or drop template text between `#if <capabilities>`, `#else` and `#endif`
 * markers; `a|b` selects either capability. A `//` or `<!--` marker alone on a
 * line removes that line; HTML comment markers can also select inline Markdown.
 * @param {string} text @param {Record<Capability, boolean>} enabled @param {string} file
 */
function render(text, enabled, file) {
  const marker =
    /^[ \t]*(?:\/\/|<!--)#(if|else|endif)(?:[ \t]+([\w|]+))?[ \t]*(?:-->)?[ \t]*(?:\n|(?![\s\S]))|<!--#(if|else|endif)(?:[ \t]+([\w|]+))?[ \t]*-->/gm;
  /** @param {string} expression */
  const evaluate = (expression) =>
    expression.split('|').some((name) => {
      if (!capabilities.includes(/** @type {Capability} */ (name)))
        throw new Error(`Unknown capability ${name} in ${file}`);
      return enabled[/** @type {Capability} */ (name)];
    });
  /** @type {boolean[]} */
  const stack = [];
  let output = '';
  let offset = 0;
  for (const match of text.matchAll(marker)) {
    if (stack.every(Boolean)) output += text.slice(offset, match.index);
    offset = match.index + match[0].length;
    // Unmatched alternatives leave their capture groups undefined.
    const [, line, lineExpression, inline, inlineExpression] =
      /** @type {(string | undefined)[]} */ ([...match]);
    const directive = line ?? inline ?? '';
    const expression = lineExpression ?? inlineExpression;
    if (directive === 'if') {
      if (!expression) throw new Error(`Missing #if capability in ${file}`);
      stack.push(evaluate(expression));
    } else if (!stack.length || expression)
      throw new Error(`Invalid #${directive} in ${file}`);
    else if (directive === 'else') stack.push(!stack.pop());
    else stack.pop();
  }
  if (stack.length) throw new Error(`Unclosed #if in ${file}`);
  return output + text.slice(offset);
}

/** @param {import('@nx/devkit').Tree} tree
 * @param {{name: string, preset?: string, persistence?: boolean, messaging?: boolean, exposure?: boolean}} options
 */
export default async function nestApp(
  tree,
  {
    name,
    preset = 'hybrid',
    persistence = false,
    messaging = true,
    exposure = true,
  },
) {
  if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(name))
    throw new Error('Use a lowercase kebab-case project name, without a path.');
  if (preset !== 'hybrid') throw new Error('Supported app preset: hybrid.');
  /** @type {Record<Capability, boolean>} */
  const enabled = { persistence, messaging, exposure };
  for (const capability of capabilities)
    if (typeof enabled[capability] !== 'boolean')
      throw new Error(`--${capability} must be true or false.`);
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
  const selected = [
    'base',
    ...capabilities.filter((capability) => enabled[capability]),
  ];
  const imported = selected.flatMap(
    (set) =>
      runtimeDependencies[
        /** @type {keyof typeof runtimeDependencies} */ (set)
      ],
  );
  const dependencies = Object.fromEntries(
    imported.map((dependency) => {
      const version = manifest.dependencies[dependency];
      if (!version)
        throw new Error(`Root manifest does not declare ${dependency}.`);
      return [dependency, version];
    }),
  );
  const prefix = name.replaceAll('-', '_').toUpperCase();
  const unit = `bun --no-env-file test --cwd ${root} ./tests/unit`;
  /** @type {Record<string, string>} */
  const files = {
    // The single declaration consumed by composition, probes and tooling discovery.
    'application.json': JSON.stringify({ name, ...enabled }),
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
    // Packaging adds the migration tooling's own dependencies for persistence.
    'distribution.json': JSON.stringify(imported),
    'bunfig.toml': '[test]\nroot = "./tests/unit"\n',
  };
  const templates = fileURLToPath(
    new URL('./nest-app-files/', import.meta.url),
  );
  for (const set of selected) {
    const directory = join(templates, set);
    if (!existsSync(directory)) continue;
    for (const path of readdirSync(directory, {
      recursive: true,
      withFileTypes: true,
    })) {
      if (!path.isFile()) continue;
      const source = join(path.parentPath, path.name);
      const destination = relative(directory, source).replace(
        /\.template$/,
        '',
      );
      if (destination in files)
        throw new Error(`Duplicate template output ${destination}`);
      files[destination] = render(
        readFileSync(source, 'utf8'),
        enabled,
        relative(templates, source),
      )
        .replaceAll('__name__', name)
        .replaceAll('__PREFIX__', prefix)
        .replaceAll('__role__', `${name.replaceAll('-', '_')}_runtime`);
    }
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

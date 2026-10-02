import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { selectApplication } from '../../database/applications';

const root = realpathSync(fileURLToPath(new URL('../../', import.meta.url)));
const manifestSchema = z.object({
  name: z.string(),
  version: z.string(),
  dependencies: z.record(z.string(), z.string()).default({}),
  optionalDependencies: z.record(z.string(), z.string()).default({}),
  peerDependencies: z.record(z.string(), z.string()).default({}),
  peerDependenciesMeta: z
    .record(z.string(), z.object({ optional: z.boolean().optional() }))
    .default({}),
  devDependencies: z.record(z.string(), z.string()).default({}),
});
const readManifest = (directory: string) =>
  manifestSchema.parse(
    JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')),
  );
const writeJson = (path: string, value: unknown) => {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
};

/** Resolve installed packages by location, retaining nested versions from the frozen install. */
function installedPackage(name: string, from: string): string | undefined {
  let directory = from;
  while (directory === root || directory.startsWith(`${root}/`)) {
    const candidate = join(directory, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return candidate;
    directory = dirname(directory);
  }
  return undefined;
}

function copySource(from: string, to: string): void {
  cpSync(from, to, {
    recursive: true,
    dereference: true,
    filter: (path) =>
      ![
        'tests',
        'node_modules',
        'project.json',
        'tsconfig.json',
        'AGENTS.md',
        'distribution.json',
      ].includes(basename(path)),
  });
}

/** Produce a ready-to-run, platform-specific artifact; no install or workspace links at delivery. */
export function distribute(name: string, output?: string): string {
  const app = selectApplication(name);
  const appSource = join(root, 'src/apps', app.name);
  const migrations = relative(appSource, fileURLToPath(app.migrations));
  if (migrations.startsWith('..'))
    throw new Error('Migrations must belong to the selected application');
  const pinnedBun = readFileSync(join(root, '.bun-version'), 'utf8').trim();
  if (Bun.version !== pinnedBun)
    throw new Error(`Distribution requires Bun ${pinnedBun}`);
  const destination = output ? resolve(output) : join(root, 'dist', app.name);
  if (output && existsSync(destination))
    throw new Error('Output directory must not exist');
  const dependencies = z
    .array(z.string())
    .parse(
      JSON.parse(
        readFileSync(
          join(root, 'src/apps', app.name, 'distribution.json'),
          'utf8',
        ),
      ),
    );
  const sourceManifest = readManifest(root);
  const direct: Record<string, string> = {};
  const copied = new Set<string>();
  const inventory: { name: string; version: string; path: string }[] = [];
  mkdirSync(dirname(destination), { recursive: true });
  const temporary = mkdtempSync(
    join(dirname(destination), `.${app.name}-distribution-`),
  );
  try {
    function copyPackage(
      packageName: string,
      from: string,
      required = true,
    ): void {
      const installed = installedPackage(packageName, from);
      if (!installed) {
        if (required)
          throw new Error(
            `Missing installed dependency ${packageName} from ${relative(root, from)}`,
          );
        return;
      }
      const source = realpathSync(installed);
      const privatePackage = source.startsWith(join(root, 'src/packages/'));
      if (!privatePackage && !source.startsWith(join(root, 'node_modules/')))
        throw new Error(
          `Dependency outside the installed workspace: ${packageName}`,
        );
      const manifest = readManifest(source);
      const path = privatePackage
        ? join('node_modules', manifest.name)
        : relative(root, source);
      const target = join(temporary, path);
      const installedPath = relative(root, installed).replace(
        /^src\/packages\/([^/]+)\/node_modules\//,
        'node_modules/@starter/$1/node_modules/',
      );
      const alias = join(temporary, installedPath);
      if (alias !== target && !existsSync(alias)) {
        mkdirSync(dirname(alias), { recursive: true });
        symlinkSync(relative(dirname(alias), target), alias);
      }
      if (copied.has(source)) return;
      copied.add(source);
      if (privatePackage) copySource(source, target);
      else
        cpSync(source, target, {
          recursive: true,
          dereference: true,
          filter: (file) =>
            file === source || basename(file) !== 'node_modules',
        });
      inventory.push({ name: manifest.name, version: manifest.version, path });
      for (const dependency of Object.keys(manifest.dependencies))
        copyPackage(
          dependency,
          source,
          !(dependency in manifest.optionalDependencies),
        );
      for (const dependency of Object.keys(manifest.optionalDependencies))
        copyPackage(dependency, source, false);
      for (const dependency of Object.keys(manifest.peerDependencies))
        copyPackage(
          dependency,
          source,
          !(manifest.peerDependenciesMeta[dependency] ?? {}).optional,
        );
    }
    for (const dependency of dependencies) {
      const version =
        sourceManifest.dependencies[dependency] ??
        sourceManifest.devDependencies[dependency];
      if (!version)
        throw new Error(`Undeclared distribution dependency: ${dependency}`);
      copyPackage(dependency, root);
      const installed = installedPackage(dependency, root);
      if (!installed) throw new Error(`Missing ${dependency}`);
      direct[dependency] = readManifest(installed).version;
    }
    copySource(appSource, join(temporary, 'app'));
    mkdirSync(join(temporary, 'database'));
    for (const file of ['migrate.mjs', 'distribution.ts'])
      cpSync(join(root, 'database', file), join(temporary, 'database', file));
    for (const file of ['applications', 'target'])
      writeFileSync(
        join(temporary, 'database', `${file}.ts`),
        "export { selectApplication, databaseTarget } from './distribution';\n",
      );
    writeJson(join(temporary, 'package.json'), {
      name: `starter-${app.name}-distribution`,
      version: sourceManifest.version,
      private: true,
      service: app.name,
      engines: { bun: pinnedBun },
      scripts: {
        start: 'bun --no-env-file app/main.ts',
        'migration:up': 'bun --no-env-file database/migrate.mjs up',
        'migration:down': 'bun --no-env-file database/migrate.mjs down',
        'migration:status': 'bun --no-env-file database/migrate.mjs status',
      },
      dependencies: direct,
      bundledDependencies: Object.keys(direct),
    });
    cpSync(
      join(root, 'tooling/config/typescript.json'),
      join(temporary, 'tsconfig.json'),
    );
    writeFileSync(join(temporary, 'bunfig.toml'), 'env = false\n');
    cpSync(join(root, '.bun-version'), join(temporary, '.bun-version'));
    cpSync(join(root, 'bun.lock'), join(temporary, 'workspace.bun.lock'));
    cpSync(join(root, 'docs/distribution.md'), join(temporary, 'README.md'));
    writeJson(join(temporary, 'distribution.json'), {
      service: app.name,
      database: {
        prefix: app.prefix,
        runtimeRole: app.runtimeRole,
        migrations: join('app', migrations),
      },
      bun: pinnedBun,
      platform: process.platform,
      arch: process.arch,
      packages: inventory.sort((a, b) => a.path.localeCompare(b.path)),
    });
    if (!output) rmSync(destination, { recursive: true, force: true });
    renameSync(temporary, destination);
    return destination;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

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
import { readApplicationDeclaration } from '@starter/capabilities/declaration';
import { applications } from '../../database/applications';
import {
  containsPath,
  installedPackage,
  packageInstallPath,
} from './distribution-paths';

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

/** Database tooling copied into persistent artifacts beside generated re-exports. */
const migrationTooling = ['migrate.mjs', 'distribution.ts'];

/** Packages the copied tooling imports; application manifests list only runtime imports. */
function migrationPackages(): string[] {
  return [
    ...new Set(
      migrationTooling.flatMap((file) =>
        new Bun.Transpiler({ loader: file.endsWith('.ts') ? 'ts' : 'js' })
          .scanImports(readFileSync(join(root, 'database', file), 'utf8'))
          .map(({ path }) => path)
          .filter((path) => !/^(\.|\/|node:|bun(:|$))/.test(path))
          .map((path) =>
            path
              .split('/')
              .slice(0, path.startsWith('@') ? 2 : 1)
              .join('/'),
          ),
      ),
    ),
  ];
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
  if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(name))
    throw new Error('Invalid application name');
  const appSource = join(root, 'src/apps', name);
  z.object({
    name: z.literal(name),
    projectType: z.literal('application'),
  }).parse(JSON.parse(readFileSync(join(appSource, 'project.json'), 'utf8')));
  if (!existsSync(join(appSource, 'application.json')))
    throw new Error(
      'Declare the application capabilities in application.json before distributing it',
    );
  const declaration = readApplicationDeclaration(
    join(appSource, 'application.json'),
  );
  if (declaration.name !== name)
    throw new Error(`application.json must declare name "${name}"`);
  const app = applications.find((entry) => entry.name === name);
  if (!declaration.persistence && existsSync(join(appSource, 'database')))
    throw new Error(
      'Declare persistence in application.json before distributing database content',
    );
  const migrations = app
    ? relative(appSource, fileURLToPath(app.migrations))
    : undefined;
  if (app && !containsPath(appSource, fileURLToPath(app.migrations)))
    throw new Error('Migrations must belong to the selected application');
  if (app && !existsSync(app.migrations))
    throw new Error(
      'Declared persistence requires an owned database/migrations directory',
    );
  const pinnedBun = readFileSync(join(root, '.bun-version'), 'utf8').trim();
  if (Bun.version !== pinnedBun)
    throw new Error(`Distribution requires Bun ${pinnedBun}`);
  const destination = output ? resolve(output) : join(root, 'dist', name);
  if (output && existsSync(destination))
    throw new Error('Output directory must not exist');
  const dependencies = [
    ...new Set([
      ...z
        .array(z.string())
        .parse(
          JSON.parse(
            readFileSync(join(appSource, 'distribution.json'), 'utf8'),
          ),
        ),
      ...(app ? migrationPackages() : []),
    ]),
  ];
  const sourceManifest = readManifest(root);
  const direct: Record<string, string> = {};
  const copied = new Set<string>();
  const inventory: { name: string; version: string; path: string }[] = [];
  mkdirSync(dirname(destination), { recursive: true });
  const temporary = mkdtempSync(
    join(dirname(destination), `.${name}-distribution-`),
  );
  try {
    function copyPackage(
      packageName: string,
      from: string,
      required = true,
    ): void {
      const installed = installedPackage(root, packageName, from);
      if (!installed) {
        if (required)
          throw new Error(
            `Missing installed dependency ${packageName} from ${relative(root, from)}`,
          );
        return;
      }
      const source = realpathSync(installed);
      const privatePackage = containsPath(join(root, 'src/packages'), source);
      if (!privatePackage && !containsPath(join(root, 'node_modules'), source))
        throw new Error(
          `Dependency outside the installed workspace: ${packageName}`,
        );
      const manifest = readManifest(source);
      const path = privatePackage
        ? join('node_modules', manifest.name)
        : relative(root, source);
      const target = join(temporary, path);
      const installedPath = packageInstallPath(root, installed);
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
      const installed = installedPackage(root, dependency, root);
      if (!installed) throw new Error(`Missing ${dependency}`);
      direct[dependency] = readManifest(installed).version;
    }
    copySource(appSource, join(temporary, 'app'));
    if (app) {
      mkdirSync(join(temporary, 'database'));
      for (const file of migrationTooling)
        cpSync(join(root, 'database', file), join(temporary, 'database', file));
      for (const file of ['applications', 'target'])
        writeFileSync(
          join(temporary, 'database', `${file}.ts`),
          "export { selectApplication, databaseTarget } from './distribution';\n",
        );
    }
    writeJson(join(temporary, 'package.json'), {
      name: `starter-${name}-distribution`,
      version: sourceManifest.version,
      private: true,
      service: name,
      engines: { bun: pinnedBun },
      scripts: {
        start: 'bun --no-env-file app/main.ts',
        ...(app
          ? {
              'migration:up': 'bun --no-env-file database/migrate.mjs up',
              'migration:down': 'bun --no-env-file database/migrate.mjs down',
              'migration:status':
                'bun --no-env-file database/migrate.mjs status',
            }
          : {}),
      },
      dependencies: direct,
      bundledDependencies: Object.keys(direct),
    });
    cpSync(
      join(root, 'tooling/config/typescript.json'),
      join(temporary, 'tsconfig.json'),
    );
    // Dependencies are bundled: a missing package must fail, never auto-install.
    writeFileSync(
      join(temporary, 'bunfig.toml'),
      'env = false\n\n[install]\nauto = "disable"\n',
    );
    cpSync(join(root, '.bun-version'), join(temporary, '.bun-version'));
    cpSync(join(root, 'bun.lock'), join(temporary, 'workspace.bun.lock'));
    cpSync(
      existsSync(join(appSource, 'README.md'))
        ? join(appSource, 'README.md')
        : join(root, 'docs/distribution.md'),
      join(temporary, 'README.md'),
    );
    writeJson(join(temporary, 'distribution.json'), {
      service: name,
      ...(app && migrations !== undefined
        ? {
            database: {
              prefix: app.prefix,
              runtimeRole: app.runtimeRole,
              migrations: join('app', migrations),
            },
          }
        : {}),
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

import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  environmentPrefix,
  runtimeRole,
} from '@starter/capabilities/declaration';
import {
  manifestSchema,
  type EnvironmentManifest,
  type EnvironmentKind,
} from './environment-manifest';
import { selectedApplications } from './topology';
import {
  preparedInfrastructure,
  processSettings,
  requiredServices,
} from './owned-infrastructure';

export type {
  EnvironmentManifest,
  EnvironmentKind,
} from './environment-manifest';

export const workspaceRoot = realpathSync(
  fileURLToPath(new URL('../', import.meta.url)),
);
const workspaceId = createHash('sha256')
  .update(workspaceRoot)
  .digest('hex')
  .slice(0, 8);

function legacyDatabase(db: EnvironmentManifest['databases'][number]): boolean {
  return db.app === 'legacy' && db.prefix === 'DB' && !db.runtime;
}

export function environmentLocation(
  environment: EnvironmentKind,
  run: string,
): { project: string; directory: string; manifestPath: string } {
  if (!/^[a-z0-9][a-z0-9-]{0,23}$/.test(run))
    throw new Error('Run must be 1-24 lowercase letters, digits or hyphens.');
  const project = `ddh-${environment === 'test' ? 'test' : 'dev'}-${workspaceId}-${run}`;
  const directory = join(workspaceRoot, '.context/test-runs', project);
  return {
    project,
    directory,
    manifestPath: join(directory, 'environment.json'),
  };
}

export function readEnvironment(
  environment: EnvironmentKind,
  run: string,
  options?: { complete?: boolean },
): EnvironmentManifest {
  return readEnvironmentFile(
    environmentLocation(environment, run).manifestPath,
    options,
  );
}

/**
 * Resource identities remain scoped to the run even after a declaration is removed.
 * `complete: false` permits an outdated topology for reconciliation, inspection
 * and shutdown. Execution requires the currently selected declarations.
 */
export function readEnvironmentFile(
  path: string,
  { complete = true }: { complete?: boolean } = {},
): EnvironmentManifest {
  const manifest = manifestSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  const location = environmentLocation(manifest.environment, manifest.run);
  if (
    realpathSync(path) !== location.manifestPath ||
    manifest.project !== location.project
  ) {
    throw new Error('Environment belongs to another workspace or run.');
  }
  const listed = new Set<string>();
  for (const target of manifest.databases) {
    // Retired development resources remain owned and stoppable; never provision
    // them for new runs or expose them as migration targets.
    const legacy =
      manifest.environment === 'development' && legacyDatabase(target);
    const prefix = legacy ? 'DB' : `${environmentPrefix(target.app)}_DB`;
    if (
      listed.has(target.app) ||
      target.prefix !== prefix ||
      target.database !==
        `${manifest.project.replaceAll('-', '_')}_${target.app}` ||
      target.runtime?.username !==
        (legacy ? undefined : runtimeRole(target.app))
    ) {
      throw new Error(
        'Database is not scoped to the selected application and run.',
      );
    }
    listed.add(target.app);
  }
  if (
    complete &&
    (JSON.stringify(manifest.topology) !==
      JSON.stringify(
        selectedApplications(manifest.apps, { retainMissing: true }),
      ) ||
      manifest.topology?.some(
        (app) =>
          (app.persistence && !listed.has(app.name)) ||
          !Object.hasOwn(manifest.applicationPorts, app.name),
      ))
  )
    throw new Error(
      manifest.environment === 'development'
        ? 'Environment application declarations changed; prepare it again to reconcile the selected topology.'
        : 'Environment application registry changed; prepare a new run.',
    );
  if (
    (manifest.broker && manifest.broker.vhost !== manifest.project) ||
    (manifest.gateway &&
      manifest.gateway.name !== `${manifest.project}-gateway`)
  ) {
    throw new Error('Broker or gateway belongs to another run.');
  }
  return manifest;
}

export function activeDatabases(
  manifest: EnvironmentManifest,
): EnvironmentManifest['databases'] {
  const infrastructure = preparedInfrastructure(manifest);
  const required = requiredServices(infrastructure);
  return manifest.databases.filter((db, index) =>
    required.has(infrastructure.databases[index].service),
  );
}

export function needsMessaging(manifest: EnvironmentManifest): boolean {
  return (
    manifest.topology === undefined ||
    [...requiredServices(preparedInfrastructure(manifest)).values()].includes(
      'broker',
    )
  );
}

export function needsGateway(manifest: EnvironmentManifest): boolean {
  return manifest.topology === undefined
    ? !manifest.apps
    : [...requiredServices(preparedInfrastructure(manifest)).values()].includes(
        'gateway',
      );
}

function hostDefaults(manifest: EnvironmentManifest): Record<string, string> {
  const infrastructure = preparedInfrastructure(manifest);
  const applications = [
    ...infrastructure.applications.map((app) => app.name),
    ...infrastructure.databases
      .filter((db) => infrastructure.kind === 'development' && db.legacy)
      .map((db) => db.application),
  ];
  const settings: Record<string, string> = {};
  for (const app of applications)
    Object.assign(
      settings,
      processSettings(infrastructure, app, 'migration', 'host'),
    );
  return settings;
}

function databaseVariables(
  manifest: EnvironmentManifest,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(hostDefaults(manifest)).filter(([key]) =>
      /(^|_)DB_/.test(key),
    ),
  );
}

function brokerVariables(
  manifest: EnvironmentManifest,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(hostDefaults(manifest)).filter(
      ([key]) => key.startsWith('RABBITMQ_') || key.endsWith('_RABBITMQ_URL'),
    ),
  );
}

function gatewayVariables(
  manifest: EnvironmentManifest,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(hostDefaults(manifest)).filter(([key]) =>
      key.startsWith('GATEWAY_'),
    ),
  );
}

/** Explicit shell settings win over generated defaults; unsafe test overrides fail closed. */
export function environmentVariables(
  manifest: EnvironmentManifest,
  shell: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const defaults = hostDefaults(manifest);
  const env = {
    ...defaults,
    ...shell,
    NODE_ENV: manifest.environment,
    DDH_ENVIRONMENT_FILE: environmentLocation(
      manifest.environment,
      manifest.run,
    ).manifestPath,
  };
  if (manifest.environment === 'test') assertTestEnvironment(env);
  return env;
}

/** Validate ALL targets before any pool or destructive operation is opened. */
export function assertTestEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!env.DDH_ENVIRONMENT_FILE)
    throw new Error(
      'Refusing test target without an owned environment. Use env:prepare and env:exec.',
    );
  const manifest = readEnvironmentFile(env.DDH_ENVIRONMENT_FILE);
  if (
    manifest.environment !== 'test' ||
    manifest.status !== 'ready' ||
    env.NODE_ENV !== 'test'
  )
    throw new Error('Refusing inactive or development test environment.');
  const databases = databaseVariables(manifest);
  const recognized = new Set(Object.keys(databases));
  for (const [variable, value] of Object.entries(databases)) {
    if (env[variable] !== value)
      throw new Error(
        `Refusing test target: ${variable} differs from the owned run.`,
      );
  }
  for (const key of Object.keys(env)) {
    if (
      (/(^|_)DB_(MIGRATION_)?(HOST|PORT|USERNAME|PASSWORD|NAME|URL)$/.test(
        key,
      ) ||
        /(^|_)DATABASE_URL$/.test(key)) &&
      !recognized.has(key)
    ) {
      throw new Error(`Refusing unregistered database target: ${key}.`);
    }
  }
  for (const [key, value] of Object.entries(brokerVariables(manifest))) {
    if (env[key] !== value)
      throw new Error(
        `Refusing broker target: ${key} differs from the owned run.`,
      );
  }
  if (env.RABBITMQ_URL)
    throw new Error('Use the scoped RABBITMQ_* fields, not RABBITMQ_URL.');
  for (const [key, value] of Object.entries(gatewayVariables(manifest))) {
    if (env[key] !== value)
      throw new Error(
        `Refusing gateway target: ${key} differs from the owned run.`,
      );
  }
  const broker = brokerVariables(manifest);
  const gateway = gatewayVariables(manifest);
  // Preparation inputs need not be exported runtime targets. Validate them
  // against owned inventory when present, even if the service is inactive.
  const preparationOverrides = {
    RABBITMQ_PORT: manifest.broker?.port,
    RABBITMQ_MANAGEMENT_PORT: manifest.broker?.managementPort,
    GATEWAY_HOST: manifest.gateway?.host,
    GATEWAY_PROXY_PORT: manifest.gateway?.proxyPort,
    GATEWAY_ADMIN_PORT: manifest.gateway?.adminPort,
  };
  for (const [key, value] of Object.entries(preparationOverrides)) {
    if (
      env[key] !== undefined &&
      value !== undefined &&
      env[key] !== String(value)
    )
      throw new Error(
        `Refusing ${key.startsWith('RABBITMQ_') ? 'broker' : 'gateway'} target: ${key} differs from the owned run.`,
      );
  }
  const registered = new Set([
    ...Object.keys(databases),
    ...Object.keys(broker),
    ...Object.keys(gateway),
    ...Object.keys(preparationOverrides),
    ...(manifest.topology ?? []).map(
      (app) => `${environmentPrefix(app.name)}_HTTP_PORT`,
    ),
  ]);
  for (const key of Object.keys(env)) {
    if (
      (key.startsWith('RABBITMQ_') || /_RABBITMQ_URL$/.test(key)) &&
      !registered.has(key)
    )
      throw new Error(`Refusing unregistered broker target: ${key}.`);
    if (key.startsWith('GATEWAY_') && !registered.has(key))
      throw new Error(`Refusing unregistered gateway target: ${key}.`);
  }
  for (const app of manifest.topology ?? []) {
    const key = `${environmentPrefix(app.name)}_HTTP_PORT`;
    if (env[key] !== String(manifest.applicationPorts[app.name]))
      throw new Error(
        `Refusing gateway target: ${key} differs from the owned run.`,
      );
  }
}

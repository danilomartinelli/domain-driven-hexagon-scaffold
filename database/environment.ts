import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { applications } from './applications';

export const workspaceRoot = realpathSync(
  fileURLToPath(new URL('../', import.meta.url)),
);
const workspaceId = createHash('sha256')
  .update(workspaceRoot)
  .digest('hex')
  .slice(0, 8);
const port = z.number().int().min(1).max(65535);
const targetSchema = z.object({
  app: z.string(),
  prefix: z.string(),
  host: z.literal('127.0.0.1'),
  port,
  /** Owner role: migration authority, and the application's role when no runtime role is registered. */
  username: z.string(),
  password: z.string(),
  database: z.string(),
  runtime: z.object({ username: z.string(), password: z.string() }).optional(),
});
const manifestSchema = z.object({
  environment: z.enum(['test', 'development']),
  run: z.string(),
  project: z.string(),
  owner: z.uuid(),
  status: z.enum(['starting', 'ready', 'stopped']),
  databases: z.array(targetSchema).min(1),
  broker: z.object({
    port,
    managementPort: port,
    username: z.string(),
    password: z.string(),
    vhost: z.string(),
  }),
  gateway: z.object({
    name: z.string(),
    host: z.string(),
    proxyPort: port,
    adminPort: port,
    userPort: port,
    walletPort: port,
  }),
});
export type EnvironmentManifest = z.infer<typeof manifestSchema>;
export type EnvironmentKind = EnvironmentManifest['environment'];

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
 * Every listed database must belong to a registered application and this run.
 * `complete: false` accepts a development manifest that predates a newly
 * registered application, so preparation can add it and shutdown still works.
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
    const application =
      applications.find((app) => app.name === target.app) ??
      (manifest.environment === 'development' && target.app === 'legacy'
        ? { name: 'legacy', prefix: 'DB', runtimeRole: undefined }
        : undefined);
    if (
      !application ||
      listed.has(target.app) ||
      target.prefix !== application.prefix ||
      target.database !==
        `${manifest.project.replaceAll('-', '_')}_${application.name}` ||
      target.runtime?.username !== application.runtimeRole
    ) {
      throw new Error(
        'Database is not scoped to the selected application and run.',
      );
    }
    listed.add(target.app);
  }
  if (complete && applications.some((app) => !listed.has(app.name)))
    throw new Error(
      manifest.environment === 'development'
        ? 'Environment application registry changed; prepare it again to add the new application databases.'
        : 'Environment application registry changed; prepare a new run.',
    );
  if (
    manifest.broker.vhost !== manifest.project ||
    manifest.gateway.name !== `${manifest.project}-gateway`
  ) {
    throw new Error('Broker or gateway belongs to another run.');
  }
  return manifest;
}

function databaseVariables(
  manifest: EnvironmentManifest,
): Record<string, string> {
  const variables: Record<string, string> = {};
  for (const db of manifest.databases) {
    const connectAs = db.runtime ?? db;
    Object.assign(variables, {
      [`${db.prefix}_HOST`]: db.host,
      [`${db.prefix}_PORT`]: String(db.port),
      [`${db.prefix}_USERNAME`]: connectAs.username,
      [`${db.prefix}_PASSWORD`]: connectAs.password,
      [`${db.prefix}_NAME`]: db.database,
    });
    if (db.runtime)
      Object.assign(variables, {
        [`${db.prefix}_MIGRATION_USERNAME`]: db.username,
        [`${db.prefix}_MIGRATION_PASSWORD`]: db.password,
      });
  }
  return variables;
}

function brokerVariables(
  manifest: EnvironmentManifest,
): Record<string, string> {
  return {
    RABBITMQ_HOST: '127.0.0.1',
    RABBITMQ_PORT: String(manifest.broker.port),
    RABBITMQ_USERNAME: manifest.broker.username,
    RABBITMQ_PASSWORD: manifest.broker.password,
    RABBITMQ_VHOST: manifest.broker.vhost,
    RABBITMQ_MANAGEMENT_URL: `http://127.0.0.1:${String(manifest.broker.managementPort)}`,
  };
}

/** Explicit shell settings win over generated defaults; unsafe test overrides fail closed. */
export function environmentVariables(
  manifest: EnvironmentManifest,
  shell: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const defaults = {
    ...databaseVariables(manifest),
    ...brokerVariables(manifest),
    GATEWAY_NAME: manifest.gateway.name,
    GATEWAY_HOST: manifest.gateway.host,
    GATEWAY_PROXY_PORT: String(manifest.gateway.proxyPort),
    GATEWAY_ADMIN_PORT: String(manifest.gateway.adminPort),
    USER_HTTP_PORT: String(manifest.gateway.userPort),
    WALLET_HTTP_PORT: String(manifest.gateway.walletPort),
  };
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
}

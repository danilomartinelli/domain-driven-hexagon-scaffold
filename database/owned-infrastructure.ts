import {
  environmentPrefix,
  runtimeRole,
  type ApplicationDeclaration,
} from '@starter/capabilities/declaration';
import type { EnvironmentManifest } from './environment-manifest';

export type InfrastructureKind = 'development' | 'test' | 'installation';
export type ServiceRole = 'application' | 'database' | 'broker' | 'gateway';
export type Credential = { value: string } | { file: string };

export interface OwnedIdentities {
  application: string;
  applicationService: string;
  database: {
    service: string;
    volume?: string;
    database: string;
    owner: string;
    runtime: string;
    secrets: string[];
  };
  broker: {
    service: string;
    volume?: string;
    vhost: string;
    username: string;
    secrets: string[];
  };
  gateway: { service: string; name: string };
}

/** Infrastructure identities shared by every application of one inventory. */
export function newSharedIdentities(
  kind: InfrastructureKind,
  project: string,
): Pick<OwnedIdentities, 'broker' | 'gateway'> {
  const installation = kind === 'installation';
  return {
    broker: {
      service: 'rabbitmq',
      ...(kind !== 'test' && { volume: 'rabbitmq' }),
      vhost: project,
      username: installation ? 'scaffold' : 'starter',
      secrets: installation ? ['broker-password'] : [],
    },
    gateway: { service: 'gateway', name: `${project}-gateway` },
  };
}

/** Names assigned at provisioning; ports and passwords remain caller-owned. */
export function newIdentities(
  kind: InfrastructureKind,
  project: string,
  application: string,
): OwnedIdentities {
  const role = runtimeRole(application);
  const installation = kind === 'installation';
  const database = installation
    ? application.replaceAll('-', '_')
    : `${project.replaceAll('-', '_')}_${application}`;
  return {
    application,
    applicationService: `app-${application}`,
    database: {
      service: `postgres-${application}`,
      ...(kind !== 'test' && {
        volume: installation
          ? `postgres-${application}`
          : `${application}-postgres`,
      }),
      database,
      owner: installation ? `${database}_owner` : 'starter',
      runtime: role,
      secrets: installation
        ? ['admin', 'owner', 'runtime'].map(
            (authority) => `${application}-${authority}-password`,
          )
        : [],
    },
    ...newSharedIdentities(kind, project),
  };
}

export interface OwnedDatabase {
  application: string;
  prefix: string;
  service: string;
  /** Compose volume; absent for tmpfs storage. */
  volume?: string;
  database: string;
  host: string;
  port: number;
  owner: { username: string; password: Credential };
  runtime?: { username: string; password: Credential };
  /** Installation secret files: administrator, owner and runtime passwords. */
  secrets: string[];
  legacy: boolean;
}

export interface OwnedInfrastructure {
  kind: InfrastructureKind;
  project: string;
  applications: readonly ApplicationDeclaration[];
  applicationPorts: Readonly<Record<string, number>>;
  /** Every recorded database, including those of disabled or removed applications. */
  databases: OwnedDatabase[];
  broker?: {
    service: string;
    volume?: string;
    host: string;
    port: number;
    managementPort?: number;
    username: string;
    password: Credential;
    vhost: string;
    secrets: string[];
  };
  gateway?: {
    service: string;
    name: string;
    host: string;
    proxyPort: number;
    adminPort?: number;
  };
}

/** Normalize the prepared inventory without reading source declarations or the shell. */
export function preparedInfrastructure(
  manifest: EnvironmentManifest,
): OwnedInfrastructure {
  const shared = newSharedIdentities(manifest.environment, manifest.project);
  return {
    kind: manifest.environment,
    project: manifest.project,
    applications: manifest.topology ?? [],
    applicationPorts: manifest.applicationPorts,
    databases: manifest.databases.map((db) => ({
      application: db.app,
      prefix: db.prefix,
      service: db.service,
      ...(db.volume !== undefined && { volume: db.volume }),
      database: db.database,
      host: db.host,
      port: db.port,
      owner: { username: db.username, password: { value: db.password } },
      ...(db.runtime && {
        runtime: {
          username: db.runtime.username,
          password: { value: db.runtime.password },
        },
      }),
      secrets: [],
      legacy: db.app === 'legacy' && db.prefix === 'DB' && !db.runtime,
    })),
    ...(manifest.broker && {
      broker: {
        ...manifest.broker,
        service: shared.broker.service,
        host: '127.0.0.1',
        password: { value: manifest.broker.password },
        secrets: [],
      },
    }),
    ...(manifest.gateway && {
      gateway: { ...manifest.gateway, service: shared.gateway.service },
    }),
  };
}

/** Structural input keeps the database tooling independent of script-owned types. */
export interface InstallationInventory {
  project: string;
  applied: { applications: readonly { declaration: ApplicationDeclaration }[] };
  /** Identities recorded when first provisioned; they outlive their application's selection. */
  retained: {
    databases: readonly {
      application: string;
      service: string;
      /** Docker volume name, scoped by the installation's Compose project. */
      volume: string;
      database: string;
      /** Owner and runtime roles. */
      roles: readonly string[];
      /** Administrator, owner and runtime password secrets. */
      secrets: readonly string[];
    }[];
    broker?: {
      service: string;
      volume: string;
      vhost: string;
      username: string;
      secrets: readonly string[];
    };
  };
}

/** Normalize the installation inventory from its retained identities, never from declarations. */
export function installationInfrastructure(
  inventory: InstallationInventory,
): OwnedInfrastructure {
  const { project, retained } = inventory;
  const applications = inventory.applied.applications.map(
    ({ declaration }) => declaration,
  );
  for (const app of applications)
    if (
      app.persistence &&
      !retained.databases.some((entry) => entry.application === app.name)
    )
      throw new Error(`Missing retained database identity: ${app.name}`);
  if (applications.some((app) => app.messaging) && !retained.broker)
    throw new Error('Missing retained broker identity');
  if (retained.broker && retained.broker.secrets.length !== 1)
    throw new Error('Invalid retained broker identity');
  const composeVolume = (volume: string) => {
    if (!volume.startsWith(`${project}_`))
      throw new Error(`Retained volume belongs to another project: ${volume}`);
    return volume.slice(project.length + 1);
  };
  const secretFile = (secret: string): Credential => ({
    file: `/run/secrets/${secret}`,
  });
  const { gateway } = newSharedIdentities('installation', project);
  return {
    kind: 'installation',
    project,
    applications,
    applicationPorts: Object.fromEntries(
      applications.map((app) => [app.name, 3000]),
    ),
    databases: retained.databases.map((entry) => {
      if (entry.roles.length !== 2 || entry.secrets.length !== 3)
        throw new Error(
          `Invalid retained database identity: ${entry.application}`,
        );
      const [owner, runtime] = entry.roles;
      const [, ownerSecret, runtimeSecret] = entry.secrets;
      return {
        application: entry.application,
        prefix: `${environmentPrefix(entry.application)}_DB`,
        service: entry.service,
        volume: composeVolume(entry.volume),
        database: entry.database,
        host: entry.service,
        port: 5432,
        owner: { username: owner, password: secretFile(ownerSecret) },
        runtime: { username: runtime, password: secretFile(runtimeSecret) },
        secrets: [...entry.secrets],
        legacy: false,
      };
    }),
    ...(retained.broker && {
      broker: {
        service: retained.broker.service,
        volume: composeVolume(retained.broker.volume),
        host: retained.broker.service,
        port: 5672,
        username: retained.broker.username,
        password: secretFile(retained.broker.secrets[0]),
        vhost: retained.broker.vhost,
        secrets: [...retained.broker.secrets],
      },
    }),
    // The gateway keeps no durable state, so it is not retained.
    ...(applications.some((app) => app.exposure) && {
      gateway: { ...gateway, host: gateway.service, proxyPort: 8443 },
    }),
  };
}

/** One application's recorded database, also after the application is disabled or removed. */
export function ownedDatabase(
  infrastructure: OwnedInfrastructure,
  application: string,
): OwnedDatabase {
  const database = infrastructure.databases.find(
    (entry) => entry.application === application,
  );
  if (!database) throw new Error(`Missing database identity: ${application}`);
  return database;
}

/** The long-running services required by a selection, with legacy development storage retained. */
export function requiredServices(
  infrastructure: OwnedInfrastructure,
): Map<string, ServiceRole> {
  const roles = new Map<string, ServiceRole>();
  // Resources a preparation has not allocated yet are named as it will provision them.
  const { kind, project } = infrastructure;
  const shared = newSharedIdentities(kind, project);
  for (const app of infrastructure.applications) {
    if (kind !== 'test') roles.set(`app-${app.name}`, 'application');
    if (app.persistence)
      roles.set(
        infrastructure.databases.find((entry) => entry.application === app.name)
          ?.service ?? newIdentities(kind, project, app.name).database.service,
        'database',
      );
    if (app.messaging)
      roles.set(
        infrastructure.broker?.service ?? shared.broker.service,
        'broker',
      );
    if (app.exposure)
      roles.set(
        infrastructure.gateway?.service ?? shared.gateway.service,
        'gateway',
      );
  }
  if (infrastructure.kind === 'development')
    for (const db of infrastructure.databases)
      if (db.legacy) roles.set(db.service, 'database');
  return roles;
}

function passwordSettings(
  key: string,
  credential: Credential,
): Record<string, string> {
  return 'file' in credential
    ? { [`${key}_FILE`]: credential.file }
    : { [key]: credential.value };
}

function brokerUrl(
  broker: NonNullable<OwnedInfrastructure['broker']>,
  password: string,
  vantage: 'host' | 'container',
): string {
  const host = vantage === 'container' ? broker.service : broker.host;
  const port = vantage === 'container' ? 5672 : broker.port;
  return `amqp://${encodeURIComponent(broker.username)}:${encodeURIComponent(password)}@${host}:${String(port)}/${encodeURIComponent(broker.vhost)}`;
}

/** Settings for one process. Explicit overrides are applied after network translation. */
export function processSettings(
  infrastructure: OwnedInfrastructure,
  application: string,
  process: 'runtime' | 'migration',
  vantage: 'host' | 'container',
  overrides: Readonly<Record<string, string>> = {},
  // Platform images may supply a complete setting set; its key set stays intact.
  settings?: Readonly<Record<string, string>>,
): Record<string, string> {
  const installation = infrastructure.kind === 'installation';
  if (installation && vantage === 'host')
    throw new Error('Installations have no host vantage');
  const app = infrastructure.applications.find(
    (entry) => entry.name === application,
  );
  const db = infrastructure.databases.find(
    (entry) => entry.application === application,
  );
  const legacy = infrastructure.kind === 'development' && db?.legacy;
  if (!app && !legacy)
    throw new Error(`Application is not selected: ${application}`);
  const prefix = legacy ? 'DB' : `${environmentPrefix(application)}_DB`;
  const env: Record<string, string> = installation
    ? {
        NODE_ENV: 'production',
        ...(process === 'migration' && { DATABASE_APP: application }),
      }
    : {};
  if (!(installation && process === 'migration') && app)
    env[`${environmentPrefix(application)}_HTTP_PORT`] = String(
      infrastructure.applicationPorts[application],
    );
  if ((app?.persistence || legacy) && db) {
    Object.assign(env, {
      [`${prefix}_HOST`]: db.host,
      [`${prefix}_PORT`]: String(db.port),
      ...(installation && process === 'migration'
        ? {}
        : {
            ...(installation ? { [`${prefix}_NAME`]: db.database } : {}),
            [`${prefix}_USERNAME`]: (db.runtime ?? db.owner).username,
            ...passwordSettings(
              `${prefix}_PASSWORD`,
              (db.runtime ?? db.owner).password,
            ),
            ...(!installation ? { [`${prefix}_NAME`]: db.database } : {}),
          }),
    });
    if (process === 'migration' && db.runtime) {
      if (installation) env[`${prefix}_NAME`] = db.database;
      Object.assign(env, {
        [`${prefix}_MIGRATION_USERNAME`]: db.owner.username,
        ...passwordSettings(`${prefix}_MIGRATION_PASSWORD`, db.owner.password),
      });
    }
  }
  const broker = infrastructure.broker;
  if (app?.messaging && broker && !(installation && process === 'migration')) {
    Object.assign(env, {
      RABBITMQ_HOST: broker.host,
      RABBITMQ_PORT: String(broker.port),
      RABBITMQ_USERNAME: broker.username,
      ...passwordSettings('RABBITMQ_PASSWORD', broker.password),
      RABBITMQ_VHOST: broker.vhost,
    });
    if (vantage === 'host' && broker.managementPort !== undefined)
      env.RABBITMQ_MANAGEMENT_URL = `http://${broker.host}:${String(broker.managementPort)}`;
  }
  if (vantage === 'host' && app?.exposure && infrastructure.gateway) {
    const gateway = infrastructure.gateway;
    Object.assign(env, {
      GATEWAY_NAME: gateway.name,
      GATEWAY_HOST: gateway.host,
      GATEWAY_PROXY_PORT: String(gateway.proxyPort),
      GATEWAY_ADMIN_PORT: String(gateway.adminPort),
    });
  }
  if (!installation && app?.messaging && broker && 'value' in broker.password)
    env[`${environmentPrefix(application)}_RABBITMQ_URL`] = brokerUrl(
      broker,
      broker.password.value,
      vantage,
    );
  const result = { ...(settings ?? env) };
  if (vantage === 'container') {
    if ((app?.persistence || legacy) && db)
      Object.assign(result, {
        [`${prefix}_HOST`]: db.service,
        [`${prefix}_PORT`]: '5432',
      });
    if (
      app?.messaging &&
      broker &&
      !(installation && process === 'migration')
    ) {
      Object.assign(result, {
        RABBITMQ_HOST: broker.service,
        RABBITMQ_PORT: '5672',
      });
      if (!installation && 'value' in broker.password)
        result[`${environmentPrefix(application)}_RABBITMQ_URL`] = brokerUrl(
          broker,
          broker.password.value,
          'container',
        );
    }
  }
  const overridden = { ...result, ...overrides };
  if (vantage === 'container') delete overridden.RABBITMQ_MANAGEMENT_URL;
  return overridden;
}

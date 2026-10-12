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

export interface OwnedInfrastructure {
  kind: InfrastructureKind;
  project: string;
  applications: readonly ApplicationDeclaration[];
  applicationPorts: Readonly<Record<string, number>>;
  databases: {
    application: string;
    prefix: string;
    service: string;
    volume?: string;
    database: string;
    host: string;
    port: number;
    owner: { username: string; password: Credential };
    runtime?: { username: string; password: Credential };
    secrets: string[];
    legacy: boolean;
  }[];
  broker?: {
    service: string;
    volume?: string;
    host: string;
    port: number;
    managementPort?: number;
    username: string;
    password: Credential;
    vhost: string;
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
  return {
    kind: manifest.environment,
    project: manifest.project,
    applications: manifest.topology ?? [],
    applicationPorts: manifest.applicationPorts,
    databases: manifest.databases.map((db) => ({
      application: db.app,
      prefix: db.prefix,
      service: `postgres-${db.app}`,
      ...(manifest.environment === 'development' && {
        volume: `${db.app}-postgres`,
      }),
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
        service: 'rabbitmq',
        ...(manifest.environment === 'development' && { volume: 'rabbitmq' }),
        host: '127.0.0.1',
        password: { value: manifest.broker.password },
      },
    }),
    ...(manifest.gateway && {
      gateway: { ...manifest.gateway, service: 'gateway' },
    }),
  };
}

/** Structural input keeps the database tooling independent of script-owned types. */
export function installationInfrastructure(inventory: {
  project: string;
  applied: { applications: readonly { declaration: ApplicationDeclaration }[] };
}): OwnedInfrastructure {
  const applications = inventory.applied.applications.map(
    ({ declaration }) => declaration,
  );
  return {
    kind: 'installation',
    project: inventory.project,
    applications,
    applicationPorts: Object.fromEntries(
      applications.map((app) => [app.name, 3000]),
    ),
    // The Compose reference keeps its established installation identities.
    databases: applications
      .filter((app) => app.persistence)
      .map((app) => {
        const identity = newIdentities(
          'installation',
          inventory.project,
          app.name,
        ).database;
        return {
          application: app.name,
          prefix: `${environmentPrefix(app.name)}_DB`,
          service: identity.service,
          volume: identity.volume,
          database: identity.database,
          host: identity.service,
          port: 5432,
          owner: {
            username: identity.owner,
            password: { file: `/run/secrets/${identity.secrets[1]}` },
          },
          runtime: {
            username: identity.runtime,
            password: { file: `/run/secrets/${identity.secrets[2]}` },
          },
          secrets: identity.secrets,
          legacy: false,
        };
      }),
    ...(applications.some((app) => app.messaging) && {
      broker: {
        service: 'rabbitmq',
        volume: 'rabbitmq',
        host: 'rabbitmq',
        port: 5672,
        username: 'scaffold',
        password: { file: '/run/secrets/broker-password' },
        vhost: inventory.project,
      },
    }),
    ...(applications.some((app) => app.exposure) && {
      gateway: {
        service: 'gateway',
        name: `${inventory.project}-gateway`,
        host: 'gateway',
        proxyPort: 8443,
      },
    }),
  };
}

/** The long-running services required by a selection, with legacy development storage retained. */
export function requiredServices(
  infrastructure: OwnedInfrastructure,
): Map<string, ServiceRole> {
  const roles = new Map<string, ServiceRole>();
  for (const app of infrastructure.applications) {
    if (infrastructure.kind !== 'test')
      roles.set(`app-${app.name}`, 'application');
    if (app.persistence) {
      const db = infrastructure.databases.find(
        (entry) => entry.application === app.name,
      );
      roles.set(
        db?.service ??
          newIdentities(infrastructure.kind, infrastructure.project, app.name)
            .database.service,
        'database',
      );
    }
    if (app.messaging)
      roles.set(infrastructure.broker?.service ?? 'rabbitmq', 'broker');
    if (app.exposure)
      roles.set(infrastructure.gateway?.service ?? 'gateway', 'gateway');
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

import { isUtf8 } from 'node:buffer';
import { accessSync, constants, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { environmentPrefix } from '@starter/capabilities/declaration';
import type { DeploymentState } from './operations-config';
import { gatewayConfiguration } from './gateway';

/** Validate operator files without changing credentials or embedding them in Compose. */
export function operationsCompose(
  state: DeploymentState,
  verifySecrets = true,
): Record<string, unknown> {
  const labels = { 'dev.starter.owner': state.owner };
  const services: Record<string, unknown> = {};
  const secrets: Record<string, unknown> = {};
  const volumes: Record<string, unknown> = {};
  const networks: Record<string, unknown> = {
    private: { internal: true, labels },
  };
  const secret = (key: string): string => {
    const file = join(state.directory, 'secrets', key);
    if (verifySecrets) {
      if (!statSync(file).isFile())
        throw new Error(`Supply secret file: ${key}`);
      accessSync(file, constants.R_OK);
      if (key.endsWith('-password')) {
        const bytes = readFileSync(file);
        const content = bytes.toString('utf8');
        if (
          !isUtf8(bytes) ||
          !content.replace(/\n$/, '') ||
          content.includes('\r') ||
          content.includes('\0') ||
          content.endsWith('\n\n')
        )
          throw new Error(
            `Invalid password file: ${key}; use nonempty UTF-8 without CR or NUL and at most one trailing LF`,
          );
      }
    }
    secrets[key] = { file: file.replaceAll('$', () => '$$') };
    return key;
  };
  const healthcheck = (test: string[], interval = '2s') => ({
    test,
    interval,
    timeout: '5s',
    retries: 30,
  });
  for (const { image, declaration: app } of state.artifacts) {
    const prefix = environmentPrefix(app.name);
    const db = app.name.replaceAll('-', '_');
    const serverSecrets: string[] = [];
    const environment: Record<string, string> = {
      NODE_ENV: 'production',
      [`${prefix}_HTTP_PORT`]: '3000',
    };
    const appNetworks = ['private'];
    if (app.persistence) {
      const databaseNetwork = `database-${app.name}`;
      networks[databaseNetwork] = { internal: true, labels };
      appNetworks.push(databaseNetwork);
      const admin = secret(`${app.name}-admin-password`);
      const owner = secret(`${app.name}-owner-password`);
      const runtime = secret(`${app.name}-runtime-password`);
      volumes[`postgres-${app.name}`] = { labels };
      services[`postgres-${app.name}`] = {
        image: 'postgres:18.6-alpine',
        labels,
        networks: [databaseNetwork],
        environment: {
          POSTGRES_DB: db,
          POSTGRES_PASSWORD_FILE: `/run/secrets/${admin}`,
        },
        secrets: [admin, owner, runtime],
        volumes: [`postgres-${app.name}:/var/lib/postgresql`],
        healthcheck: healthcheck([
          'CMD-SHELL',
          'pg_isready -h 127.0.0.1 -U postgres -d "$$POSTGRES_DB"',
        ]),
      };
      Object.assign(environment, {
        [`${prefix}_DB_HOST`]: `postgres-${app.name}`,
        [`${prefix}_DB_PORT`]: '5432',
        [`${prefix}_DB_NAME`]: db,
        [`${prefix}_DB_USERNAME`]: `${db}_runtime`,
        [`${prefix}_DB_PASSWORD_FILE`]: `/run/secrets/${runtime}`,
      });
      serverSecrets.push(runtime);
      services[`migrate-${app.name}`] = {
        image,
        labels,
        profiles: ['commands'],
        networks: [databaseNetwork],
        environment: {
          NODE_ENV: 'production',
          DATABASE_APP: app.name,
          [`${prefix}_DB_HOST`]: `postgres-${app.name}`,
          [`${prefix}_DB_PORT`]: '5432',
          [`${prefix}_DB_NAME`]: db,
          [`${prefix}_DB_MIGRATION_USERNAME`]: `${db}_owner`,
          [`${prefix}_DB_MIGRATION_PASSWORD_FILE`]: `/run/secrets/${owner}`,
        },
        secrets: [owner],
        command: ['run', 'migration:status'],
      };
    }
    if (app.messaging) {
      serverSecrets.push(secret('broker-password'));
      Object.assign(environment, {
        RABBITMQ_HOST: 'rabbitmq',
        RABBITMQ_PORT: '5672',
        RABBITMQ_USERNAME: 'scaffold',
        RABBITMQ_PASSWORD_FILE: '/run/secrets/broker-password',
        RABBITMQ_VHOST: state.project,
      });
    }
    services[`app-${app.name}`] = {
      image,
      labels,
      networks: appNetworks,
      secrets: serverSecrets,
      environment,
      profiles: ['applications'],
      stop_grace_period: '20s',
      healthcheck: healthcheck([
        'CMD',
        'bun',
        '-e',
        "process.exit((await fetch('http://127.0.0.1:3000/health/live')).ok ? 0 : 1)",
      ]),
    };
  }
  if (state.artifacts.some(({ declaration }) => declaration.messaging)) {
    volumes.rabbitmq = { labels };
    services.rabbitmq = {
      image:
        'rabbitmq:4-management-alpine@sha256:628bd74c1c7e2a820bf417b32e75eed1bd8d517345d9749ee8bd4076ae393abe',
      labels,
      networks: ['private'],
      hostname: `${state.project}-rabbitmq`,
      secrets: [secret('broker-password')],
      environment: {
        RABBITMQ_DEFAULT_USER: 'scaffold',
        RABBITMQ_DEFAULT_VHOST: state.project,
      },
      entrypoint: [
        '/bin/sh',
        '-ec',
        'export RABBITMQ_DEFAULT_PASS="$$(cat /run/secrets/broker-password)"; exec docker-entrypoint.sh rabbitmq-server',
      ],
      volumes: ['rabbitmq:/var/lib/rabbitmq'],
      healthcheck: healthcheck([
        'CMD',
        'docker-entrypoint.sh',
        'rabbitmq-diagnostics',
        '-q',
        'check_port_connectivity',
      ]),
    };
  }
  const exposed = state.artifacts.filter(
    ({ declaration }) => declaration.exposure,
  );
  const configs: Record<string, unknown> = {};
  if (exposed.length) {
    if (!state.config.https)
      throw new Error(
        'Exposed applications require HTTPS bind/port and certificate files',
      );
    configs.routes = {
      content: gatewayConfiguration(
        {
          environment: 'development',
          topology: exposed.map((entry) => entry.declaration),
          applicationPorts: Object.fromEntries(
            exposed.map((entry) => [entry.declaration.name, 3000]),
          ),
        },
        true,
        ['https'],
      ).replaceAll('$', () => '$$'),
    };
    networks.ingress = { labels };
    services.gateway = {
      image:
        'kong:3.9.1@sha256:76c14b93e989f7f4418039f7f9789ca32564016211c86ac1a18022f4788e7b9c',
      labels,
      networks: ['private', 'ingress'],
      ports: [
        `${state.config.https.bind}:${String(state.config.https.port)}:8443`,
      ],
      secrets: [secret('tls.crt'), secret('tls.key')],
      configs: [{ source: 'routes', target: '/etc/kong/routes.json' }],
      environment: {
        KONG_DATABASE: 'off',
        KONG_DECLARATIVE_CONFIG: '/etc/kong/routes.json',
        KONG_PROXY_LISTEN: '0.0.0.0:8443 ssl',
        KONG_SSL_CERT: '/run/secrets/tls.crt',
        KONG_SSL_CERT_KEY: '/run/secrets/tls.key',
        KONG_ADMIN_LISTEN: 'off',
        KONG_ADMIN_GUI_LISTEN: 'off',
        KONG_STATUS_LISTEN: '127.0.0.1:8100',
        KONG_NGINX_WORKER_PROCESSES: '1',
        KONG_DNS_NOT_FOUND_TTL: '1',
        KONG_DNS_ERROR_TTL: '1',
      },
      healthcheck: healthcheck(['CMD', 'kong', 'health']),
    };
  }
  return { services, volumes, networks, secrets, configs };
}

/** Create identities only when absent; repeated preparation verifies every supplied password. */
export function provisionDatabase(app: string): string {
  const db = app.replaceAll('-', '_');
  return `set -eu
export PGHOST=127.0.0.1 PGUSER=postgres PGDATABASE=${db}
export PGPASSWORD="$(cat /run/secrets/${app}-admin-password)"
export OWNER_PASSWORD="$(cat /run/secrets/${app}-owner-password)"
export RUNTIME_PASSWORD="$(cat /run/secrets/${app}-runtime-password)"
psql -X -v ON_ERROR_STOP=1 <<'SQL'
\\getenv owner_password OWNER_PASSWORD
\\getenv runtime_password RUNTIME_PASSWORD
SELECT format('CREATE ROLE ${db}_owner LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD %L', :'owner_password') WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${db}_owner') \\gexec
SELECT format('CREATE ROLE ${db}_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD %L', :'runtime_password') WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${db}_runtime') \\gexec
ALTER DATABASE "${db}" OWNER TO ${db}_owner;
REVOKE ALL ON DATABASE "${db}" FROM PUBLIC;
GRANT CONNECT ON DATABASE "${db}" TO ${db}_owner, ${db}_runtime;
ALTER SCHEMA public OWNER TO ${db}_owner;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
SQL
PGUSER=${db}_owner PGPASSWORD="$OWNER_PASSWORD" psql -X -v ON_ERROR_STOP=1 -c 'SELECT current_user' >/dev/null
PGUSER=${db}_runtime PGPASSWORD="$RUNTIME_PASSWORD" psql -X -v ON_ERROR_STOP=1 -c 'SELECT current_user' >/dev/null`;
}

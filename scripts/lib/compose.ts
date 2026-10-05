import type { EnvironmentManifest } from '../../database/environment';
import { gatewayConfiguration } from './gateway';
import { applicationContainer } from './application-containers';

/**
 * Runs once, when the image initializes an empty cluster. The role gets no
 * privileges here: the application's migrations grant exactly what it needs.
 * Compose interpolates `$`, so it is escaped as `$$`.
 */
function runtimeRoleScript(role: { username: string; password: string }) {
  const identifier = `"${role.username.replaceAll('"', '""')}"`;
  const literal = `'${role.password.replaceAll("'", "''")}'`;
  return `CREATE ROLE ${identifier} LOGIN PASSWORD ${literal};\n`.replaceAll(
    '$',
    () => '$$',
  );
}

/** Compose's JSON form keeps every app on the same lifecycle implementation. */
export function composeConfiguration(
  manifest: EnvironmentManifest,
): Record<string, unknown> {
  const labels = { 'dev.starter.owner': manifest.owner };
  const services: Record<string, unknown> = {};
  const volumes: Record<string, unknown> = {};
  const configs: Record<string, unknown> = {};
  for (const db of manifest.databases) {
    const volume = `${db.app}-postgres`;
    if (manifest.environment === 'development') volumes[volume] = { labels };
    const runtimeRole = `${db.app}-runtime-role`;
    if (db.runtime)
      configs[runtimeRole] = { content: runtimeRoleScript(db.runtime) };
    services[`postgres-${db.app}`] = {
      image: 'postgres:18.6-alpine',
      labels,
      ports: [`127.0.0.1:${String(db.port)}:5432`],
      environment: {
        POSTGRES_USER: db.username,
        POSTGRES_PASSWORD: db.password,
        POSTGRES_DB: db.database,
      },
      ...(manifest.environment === 'test'
        ? { tmpfs: ['/var/lib/postgresql'] }
        : { volumes: [`${volume}:/var/lib/postgresql`] }),
      ...(db.runtime && {
        configs: [
          {
            source: runtimeRole,
            target: '/docker-entrypoint-initdb.d/runtime-role.sql',
          },
        ],
      }),
      healthcheck: {
        test: [
          'CMD-SHELL',
          'pg_isready -h 127.0.0.1 -U "$$POSTGRES_USER" -d "$$POSTGRES_DB"',
        ],
        interval: '1s',
        timeout: '3s',
        retries: 30,
      },
    };
  }
  if (manifest.broker) {
    services.rabbitmq = {
      hostname: `${manifest.project}-rabbitmq`,
      image:
        'rabbitmq:4-management-alpine@sha256:628bd74c1c7e2a820bf417b32e75eed1bd8d517345d9749ee8bd4076ae393abe',
      labels,
      ports: [
        `127.0.0.1:${String(manifest.broker.port)}:5672`,
        `127.0.0.1:${String(manifest.broker.managementPort)}:15672`,
      ],
      environment: {
        RABBITMQ_DEFAULT_USER: manifest.broker.username,
        RABBITMQ_DEFAULT_PASS: manifest.broker.password,
        RABBITMQ_DEFAULT_VHOST: manifest.broker.vhost,
      },
      ...(manifest.environment === 'test'
        ? { tmpfs: ['/var/lib/rabbitmq'] }
        : { volumes: ['rabbitmq:/var/lib/rabbitmq'] }),
      healthcheck: {
        // The image entrypoint runs diagnostics as rabbitmq, preserving cookie ownership.
        test: [
          'CMD',
          'docker-entrypoint.sh',
          'rabbitmq-diagnostics',
          '-q',
          'check_port_connectivity',
        ],
        interval: '2s',
        timeout: '5s',
        retries: 30,
      },
    };
    if (manifest.environment === 'development') volumes.rabbitmq = { labels };
  }
  if (manifest.gateway) {
    configs['kong-routes'] = {
      // Compose also interpolates config content, including route regex anchors.
      content: gatewayConfiguration(manifest).replaceAll('$', () => '$$'),
    };
    services.gateway = {
      image:
        'kong:3.9.1@sha256:76c14b93e989f7f4418039f7f9789ca32564016211c86ac1a18022f4788e7b9c',
      container_name: manifest.gateway.name,
      labels,
      ports: [
        `127.0.0.1:${String(manifest.gateway.proxyPort)}:8000`,
        `127.0.0.1:${String(manifest.gateway.adminPort)}:8001`,
      ],
      extra_hosts: ['host.docker.internal:host-gateway'],
      environment: {
        KONG_DATABASE: 'off',
        KONG_DECLARATIVE_CONFIG: '/etc/kong/routes.json',
        KONG_PROXY_LISTEN: '0.0.0.0:8000',
        KONG_ADMIN_LISTEN: '0.0.0.0:8001',
        KONG_ADMIN_GUI_LISTEN: 'off',
        KONG_NGINX_WORKER_PROCESSES: '1',
        KONG_DNS_NOT_FOUND_TTL: '1',
        KONG_DNS_ERROR_TTL: '1',
      },
      configs: [{ source: 'kong-routes', target: '/etc/kong/routes.json' }],
      healthcheck: {
        test: ['CMD', 'kong', 'health'],
        interval: '2s',
        timeout: '5s',
        retries: 30,
      },
    };
  }
  if (manifest.environment === 'development') {
    for (const app of manifest.topology ?? [])
      services[`app-${app.name}`] = applicationContainer(manifest, app.name);
  }
  return { services, networks: { default: { labels } }, volumes, configs };
}

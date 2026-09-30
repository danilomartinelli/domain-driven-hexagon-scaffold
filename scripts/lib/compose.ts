import type { EnvironmentManifest } from '../../database/environment';

/** Compose's JSON form keeps every app on the same lifecycle implementation. */
export function composeConfiguration(
  manifest: EnvironmentManifest,
): Record<string, unknown> {
  const labels = { 'dev.starter.owner': manifest.owner };
  const services: Record<string, unknown> = {};
  const volumes: Record<string, unknown> = {};
  for (const db of manifest.databases) {
    const volume = `${db.app}-postgres`;
    if (manifest.environment === 'development') volumes[volume] = { labels };
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
      test: ['CMD', 'rabbitmq-diagnostics', '-q', 'check_port_connectivity'],
      interval: '2s',
      timeout: '5s',
      retries: 30,
    },
  };
  if (manifest.environment === 'development') volumes.rabbitmq = { labels };
  // Reserved gateway coordinates are published in the environment manifest.
  // Kong routes and its container are introduced by the routing slice.
  return { services, networks: { default: { labels } }, volumes };
}

import type { EnvironmentManifest } from '../../database/environment';

/** Only application-owned, explicitly declared business routes join the gateway. */
export function gatewayConfiguration(
  manifest: EnvironmentManifest,
  privateApplications = manifest.environment === 'development',
): string {
  const applications = (manifest.topology ?? []).filter((app) => app.exposure);
  const upstreams = privateApplications
    ? applications.map((app) => ({
        name: `app-${app.name}`,
        targets: [
          {
            target: `app-${app.name}:${String(manifest.applicationPorts[app.name])}`,
          },
        ],
        healthchecks: {
          active: {
            type: 'http',
            http_path: '/health/ready/http',
            timeout: 2,
            healthy: { interval: 1, successes: 1 },
            unhealthy: {
              interval: 1,
              http_failures: 1,
              tcp_failures: 1,
              timeouts: 1,
              http_statuses: [500, 502, 503, 504],
            },
          },
        },
      }))
    : [];
  const services = (manifest.topology ?? [])
    .filter((app) => app.exposure)
    .flatMap((app) =>
      (app.routes ?? []).map((route) => ({
        name: `${app.name}--${route.name}`,
        host: privateApplications ? `app-${app.name}` : manifest.gateway?.host,
        port: manifest.applicationPorts[app.name],
        protocol: 'http',
        ...(route.upstreamPath ? { path: route.upstreamPath } : {}),
        routes: [
          {
            name: `${app.name}--${route.name}`,
            paths: route.paths,
            strip_path: route.stripPath,
            ...(route.methods ? { methods: route.methods } : {}),
          },
        ],
      })),
    );
  return JSON.stringify({
    _format_version: '3.0',
    services,
    ...(privateApplications ? { upstreams } : {}),
  });
}

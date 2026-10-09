import type { ApplicationDeclaration } from '@starter/capabilities/declaration';
import type { EnvironmentManifest } from '../../database/environment';

/** Kong identities used by configuration and artifact approval. */
export function gatewayNames(
  app: ApplicationDeclaration,
  port: number,
): {
  upstream: string;
  privateHost: string;
  target: string;
  routes: Record<string, { service: string; route: string }>;
} {
  const upstream = `app-${app.name}`;
  return {
    upstream,
    privateHost: upstream,
    target: `${upstream}:${String(port)}`,
    routes: Object.fromEntries(
      (app.routes ?? []).map((route) => [
        route.name,
        {
          service: `${app.name}--${route.name}`,
          route: `${app.name}--${route.name}`,
        },
      ]),
    ),
  };
}

/** Only application-owned, explicitly declared business routes join the gateway. */
export function gatewayConfiguration(
  manifest: Pick<
    EnvironmentManifest,
    'environment' | 'topology' | 'applicationPorts' | 'gateway'
  >,
  privateApplications = manifest.environment === 'development',
  protocols?: readonly string[],
  profile: 'standard' | 'approval' = 'standard',
): string {
  const applications = (manifest.topology ?? []).filter((app) => app.exposure);
  const upstreams = privateApplications
    ? applications.map((app) => {
        const names = gatewayNames(app, manifest.applicationPorts[app.name]);
        return {
          name: names.upstream,
          targets: [
            {
              target: names.target,
            },
          ],
          healthchecks: {
            ...(profile === 'approval'
              ? {
                  passive: {
                    healthy: { successes: 0 },
                    unhealthy: {
                      http_failures: 0,
                      tcp_failures: 0,
                      timeouts: 0,
                    },
                  },
                }
              : {}),
            active: {
              type: 'http',
              http_path: '/health/ready/http',
              timeout: 2,
              healthy: {
                interval: 1,
                successes: 1,
                ...(profile === 'approval' ? { http_statuses: [200] } : {}),
              },
              unhealthy: {
                interval: 1,
                http_failures: 1,
                tcp_failures: 1,
                timeouts: 1,
                http_statuses: [500, 502, 503, 504],
              },
            },
          },
        };
      })
    : [];
  const services = applications.flatMap((app) => {
    const names = gatewayNames(app, manifest.applicationPorts[app.name]);
    return (app.routes ?? []).map((route) => ({
      name: names.routes[route.name].service,
      host: privateApplications ? names.privateHost : manifest.gateway?.host,
      port: manifest.applicationPorts[app.name],
      protocol: 'http',
      ...(route.upstreamPath ? { path: route.upstreamPath } : {}),
      routes: [
        {
          name: names.routes[route.name].route,
          paths: route.paths,
          strip_path: route.stripPath,
          ...(protocols ? { protocols } : {}),
          ...(route.methods ? { methods: route.methods } : {}),
        },
      ],
    }));
  });
  return JSON.stringify({
    _format_version: '3.0',
    services,
    ...(privateApplications ? { upstreams } : {}),
  });
}

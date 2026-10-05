import type { EnvironmentManifest } from '../../database/environment';

/** Only application-owned, explicitly declared business routes join the gateway. */
export function gatewayConfiguration(manifest: EnvironmentManifest): string {
  const services = (manifest.topology ?? [])
    .filter((app) => app.exposure)
    .flatMap((app) =>
      (app.routes ?? []).map((route) => ({
        name: `${app.name}--${route.name}`,
        host: manifest.gateway?.host,
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
  return JSON.stringify({ _format_version: '3.0', services });
}

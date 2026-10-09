import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { ApplicationDeclaration } from '@starter/capabilities/declaration';
import {
  workspaceRoot,
  type EnvironmentManifest,
} from '../../database/environment';
import { runCommand } from './command';
import { gatewayConfiguration } from './gateway';

const entity = z.looseObject({ id: z.string(), name: z.string() });
const collection = z.object({
  data: z.array(entity),
  next: z.null().optional(),
});
const health = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      target: z.string(),
      data: z.object({
        addresses: z.array(
          z.object({ ip: z.string(), port: z.number(), health: z.string() }),
        ),
      }),
    }),
  ),
  next: z.null().optional(),
});

/** Installs and probes only this disposable fixture's owned DB-less gateway. */
export async function privateImageGateway(
  manifest: EnvironmentManifest,
  app: ApplicationDeclaration,
  budget: () => number,
): Promise<() => Promise<boolean>> {
  if (manifest.environment !== 'test' || manifest.topology?.length !== 1)
    throw new Error(
      'Image validation requires a disposable single-application environment',
    );
  const gateway = manifest.gateway;
  if (!gateway) {
    if (app.exposure)
      throw new Error('Exposed application has no disposable gateway');
    return () => Promise.resolve(true);
  }
  const inspected = await runCommand(['docker', 'inspect', gateway.name], {
    cwd: workspaceRoot,
    timeout: budget(),
  });
  if (inspected.code !== 0)
    throw new Error('Cannot establish disposable Kong ownership');
  z.array(
    z.object({
      Config: z.object({
        Labels: z.object({
          'dev.starter.owner': z.literal(manifest.owner),
          'com.docker.compose.project': z.literal(manifest.project),
          'com.docker.compose.service': z.literal('gateway'),
        }),
      }),
      NetworkSettings: z.object({
        Ports: z.object({
          '8001/tcp': z
            .array(
              z.object({
                HostIp: z.literal('127.0.0.1'),
                HostPort: z.literal(String(gateway.adminPort)),
              }),
            )
            .length(1),
        }),
      }),
    }),
  )
    .length(1)
    .parse(JSON.parse(inspected.stdout));
  const request = async (
    path: string,
    init?: RequestInit,
  ): Promise<Response> => {
    const response = await fetch(
      `http://127.0.0.1:${String(gateway.adminPort)}${path}`,
      {
        ...init,
        signal: AbortSignal.timeout(budget()),
      },
    );
    if (!response.ok)
      throw new Error(`Kong ${path}: HTTP ${String(response.status)}`);
    return response;
  };
  const read = async (path: string): Promise<unknown> =>
    (await request(path)).json();
  const config = JSON.parse(gatewayConfiguration(manifest, true)) as {
    upstreams: {
      healthchecks: {
        active: { healthy: { http_statuses?: number[] } };
        passive?: unknown;
      };
    }[];
  };
  for (const upstream of config.upstreams) {
    upstream.healthchecks.active.healthy.http_statuses = [200];
    upstream.healthchecks.passive = {
      healthy: { successes: 0 },
      unhealthy: { http_failures: 0, tcp_failures: 0, timeouts: 0 },
    };
  }
  await request('/config', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ config: JSON.stringify(config) }),
  });
  const routes = app.exposure ? (app.routes ?? []) : [];
  const upstreamName = `app-${app.name}`;
  let observed:
    { target: string; address: string; unhealthy: boolean } | undefined;
  let recovered = false;
  return async () => {
    const services = collection.parse(await read('/services')).data;
    const installed = collection.parse(await read('/routes')).data;
    const upstreams = collection.parse(await read('/upstreams')).data;
    const names = routes.map((route) => `${app.name}--${route.name}`).sort();
    for (const [kind, entries] of [
      ['services', services],
      ['routes', installed],
    ] as const)
      if (!isDeepStrictEqual(entries.map((entry) => entry.name).sort(), names))
        throw new Error(`Kong installed ${kind} do not match declared routing`);
    if (
      !isDeepStrictEqual(
        upstreams.map((entry) => entry.name),
        app.exposure ? [upstreamName] : [],
      )
    )
      throw new Error('Kong installed upstreams do not match exposure');
    for (const route of routes) {
      const name = `${app.name}--${route.name}`;
      const service = services.find((entry) => entry.name === name);
      const installedRoute = installed.find((entry) => entry.name === name);
      z.object({
        host: z.literal(upstreamName),
        port: z.literal(manifest.applicationPorts[app.name]),
        protocol: z.literal('http'),
        path: z.literal(route.upstreamPath ?? null),
        enabled: z.literal(true),
      }).parse(service);
      const parsed = z
        .object({
          service: z.object({ id: z.literal(service?.id ?? '') }),
          paths: z.array(z.string()),
          methods: z.array(z.string()).nullable(),
          protocols: z.array(z.string()),
          strip_path: z.literal(route.stripPath),
          preserve_host: z.literal(false),
          path_handling: z.literal('v0'),
          regex_priority: z.literal(0),
          hosts: z.null(),
          headers: z.null(),
          snis: z.null(),
          sources: z.null(),
          destinations: z.null(),
          request_buffering: z.literal(true),
          response_buffering: z.literal(true),
          https_redirect_status_code: z.literal(426),
        })
        .parse(installedRoute);
      for (const [actual, expected] of [
        [parsed.paths, route.paths],
        [parsed.methods, route.methods ?? null],
        [parsed.protocols, ['http', 'https']],
      ]) {
        if (
          !isDeepStrictEqual(
            actual ? [...actual].sort() : null,
            expected ? [...expected].sort() : null,
          )
        )
          throw new Error(`Kong route ${name} differs from declaration`);
      }
    }
    if (!app.exposure) return true;
    z.object({
      healthchecks: z.object({
        active: z.object({
          type: z.literal('http'),
          http_path: z.literal('/health/ready/http'),
          healthy: z.object({
            interval: z.literal(1),
            successes: z.literal(1),
            http_statuses: z.tuple([z.literal(200)]),
          }),
          unhealthy: z.object({
            interval: z.literal(1),
            http_failures: z.literal(1),
            tcp_failures: z.literal(1),
            timeouts: z.literal(1),
          }),
        }),
        passive: z.object({
          healthy: z.object({ successes: z.literal(0) }),
          unhealthy: z.object({
            http_failures: z.literal(0),
            tcp_failures: z.literal(0),
            timeouts: z.literal(0),
          }),
        }),
      }),
    }).parse(upstreams[0]);
    const targetState = async () => {
      const targets = health.parse(
        await read(`/upstreams/${upstreamName}/health`),
      ).data;
      if (targets.length !== 1)
        throw new Error('Kong requires exactly the selected artifact target');
      const [target] = targets;
      if (
        target.target !==
          `${upstreamName}:${String(manifest.applicationPorts[app.name])}` ||
        target.data.addresses.length !== 1
      )
        throw new Error(
          'Kong target/address does not match the selected artifact',
        );
      const [address] = target.data.addresses;
      return {
        target: target.id,
        address: `${address.ip}:${String(address.port)}`,
        health: address.health,
      };
    };
    let state = await targetState();
    if (!observed) {
      await request(
        `/upstreams/${upstreamName}/targets/${state.target}/unhealthy`,
        { method: 'PUT' },
      );
      observed = {
        target: state.target,
        address: state.address,
        unhealthy: false,
      };
      // Observe before slower private probes can consume an active-check interval.
      state = await targetState();
    }
    if (state.target !== observed.target || state.address !== observed.address)
      throw new Error('Kong target/address changed during active recovery');
    if (state.health === 'UNHEALTHY') observed.unhealthy = true;
    if (!observed.unhealthy || state.health !== 'HEALTHY') return false;
    if (!recovered) {
      console.log(
        `Kong ${upstreamName} target ${state.target} address ${state.address} UNHEALTHY -> HEALTHY`,
      );
      recovered = true;
    }
    return true;
  };
}

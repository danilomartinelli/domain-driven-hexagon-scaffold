import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { ApplicationDeclaration } from '@starter/capabilities/declaration';
import { gatewayNames } from '../gateway';
import type { GatewayEvidence } from './ports';
import type { ApprovalEnvironment, KongAdmin } from './ports';

/** Declaration comparison and the single unhealthy-to-recovered observation. */
export function observeGateway(
  manifest: ApprovalEnvironment,
  app: ApplicationDeclaration,
  kong: KongAdmin,
  budget: () => number,
): () => Promise<boolean | GatewayEvidence> {
  const routes = app.exposure ? (app.routes ?? []) : [];
  const namesFor = gatewayNames(app, manifest.applicationPorts[app.name]);
  const upstreamName = namesFor.upstream;
  let observed:
    { target: string; address: string; unhealthy: boolean } | undefined;
  let mutationFailure: Error | undefined;
  return async (): Promise<true | false | GatewayEvidence> => {
    if (mutationFailure) throw mutationFailure;
    const services = await kong.services(budget());
    const installed = await kong.routes(budget());
    const upstreams = await kong.upstreams(budget());
    const serviceNames = routes
      .map((route) => namesFor.routes[route.name].service)
      .sort();
    const routeNames = routes
      .map((route) => namesFor.routes[route.name].route)
      .sort();
    for (const [kind, entries, names] of [
      ['services', services, serviceNames],
      ['routes', installed, routeNames],
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
      const name = namesFor.routes[route.name].route;
      const service = services.find(
        (entry) => entry.name === namesFor.routes[route.name].service,
      );
      const installedRoute = installed.find((entry) => entry.name === name);
      z.object({
        host: z.literal(namesFor.privateHost),
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
      const targets = await kong.targetHealth(upstreamName, budget());
      if (targets.length !== 1)
        throw new Error('Kong requires exactly the selected artifact target');
      const [target] = targets;
      if (
        target.target !== namesFor.target ||
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
      observed = {
        target: state.target,
        address: state.address,
        unhealthy: false,
      };
      try {
        await kong.markUnhealthy(upstreamName, state.target, budget());
      } catch (error) {
        mutationFailure = new Error(
          `Kong unhealthy mutation failed: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
        throw mutationFailure;
      }
      // Observe before slower private probes can consume an active-check interval.
      state = await targetState();
    }
    if (state.target !== observed.target || state.address !== observed.address)
      throw new Error('Kong target/address changed during active recovery');
    if (state.health === 'UNHEALTHY') observed.unhealthy = true;
    if (!observed.unhealthy || state.health !== 'HEALTHY') return false;
    return {
      upstream: upstreamName,
      target: state.target,
      address: state.address,
      transition: ['UNHEALTHY', 'HEALTHY'],
    };
  };
}

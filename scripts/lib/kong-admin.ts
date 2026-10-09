import { z } from 'zod';
import {
  workspaceRoot,
  type EnvironmentManifest,
} from '../../database/environment';
import { runCommand } from './command';
import type { KongAdmin } from './artifact-approval/ports';

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

/** Typed Admin access; every mutation revalidates the disposable container and loopback binding. */
export function disposableKong(
  manifest: EnvironmentManifest,
  signal?: AbortSignal,
): KongAdmin {
  const gateway = manifest.gateway;
  if (
    !gateway ||
    manifest.environment !== 'test' ||
    manifest.topology?.length !== 1
  )
    throw new Error(
      'Kong approval requires a disposable single-application environment',
    );
  const request = async (
    path: string,
    timeout: number,
    init?: RequestInit,
  ): Promise<unknown> => {
    const deadline = performance.now() + timeout;
    const remaining = () => {
      signal?.throwIfAborted();
      const budget = Math.floor(deadline - performance.now());
      if (budget <= 0) throw new Error('Kong probe budget exhausted');
      return budget;
    };
    if (init?.method) {
      const inspected = await runCommand(['docker', 'inspect', gateway.name], {
        cwd: workspaceRoot,
        timeout: remaining(),
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
    }
    const response = await fetch(
      `http://127.0.0.1:${String(gateway.adminPort)}${path}`,
      {
        ...init,
        signal: AbortSignal.any([
          AbortSignal.timeout(remaining()),
          ...(signal ? [signal] : []),
        ]),
      },
    );
    if (!response.ok)
      throw new Error(`Kong ${path}: HTTP ${String(response.status)}`);
    const body: unknown =
      response.status === 204 ? null : await response.json();
    remaining();
    return body;
  };
  return {
    install: async (configuration, timeout) => {
      await request('/config', timeout, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ config: configuration }),
      });
    },
    services: async (timeout) =>
      collection.parse(await request('/services', timeout)).data,
    routes: async (timeout) =>
      collection.parse(await request('/routes', timeout)).data,
    upstreams: async (timeout) =>
      collection.parse(await request('/upstreams', timeout)).data,
    targetHealth: async (upstream, timeout) =>
      health.parse(
        await request(
          `/upstreams/${encodeURIComponent(upstream)}/health`,
          timeout,
        ),
      ).data,
    markUnhealthy: async (upstream, target, timeout) => {
      await request(
        `/upstreams/${encodeURIComponent(upstream)}/targets/${encodeURIComponent(target)}/unhealthy`,
        timeout,
        { method: 'PUT' },
      );
    },
  };
}

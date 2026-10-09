import { z } from 'zod';
import type { ApplicationDeclaration } from '@starter/capabilities/declaration';
import type { EnvironmentManifest } from '../../database/environment';
import { privateImageGateway } from './image-gateway';

const role = z.union([
  z.strictObject({ status: z.literal('not_applicable') }),
  z.object({
    status: z.enum(['ready', 'not_ready']),
    connected: z.boolean(),
    failures: z.number().int().nonnegative(),
    retries: z.number().int().nonnegative(),
    retryDelayMs: z.number().nonnegative(),
    lastFailureAt: z.string().nullable(),
    reason: z.string().nullable(),
  }),
]);

export function readinessBudget(deadline: number): number {
  const remaining = Math.floor(deadline - performance.now());
  if (remaining <= 0)
    throw new Error('Publication readiness window exhausted (60000 ms)');
  return Math.min(2000, remaining);
}

/** Approval is stricter than process startup: every applicable role must be ready. */
export async function validatePublicationReadiness(
  app: ApplicationDeclaration,
  manifest: EnvironmentManifest,
  deadline: number,
  probe: (
    path: string,
    timeout: number,
  ) => Promise<{ status: number; body: unknown }>,
): Promise<void> {
  const snapshot = z.object({
    service: z.literal(app.name),
    lifecycle: z.literal('running'),
    http: z.object({ status: z.literal('ready') }),
    database: z.object({
      status: z.literal(app.persistence ? 'ready' : 'not_applicable'),
    }),
    consumer: role,
    publisher: role,
  });
  let gateway: Awaited<ReturnType<typeof privateImageGateway>> | undefined;
  let unmet = 'private HTTP and capability readiness not observed';
  while (performance.now() < deadline) {
    try {
      gateway ??= await privateImageGateway(manifest, app, () =>
        readinessBudget(deadline),
      );
      const connected = await gateway();
      const http = await probe('/health/ready/http', readinessBudget(deadline));
      z.object({
        service: z.literal(app.name),
        status: z.literal('ready'),
      }).parse(http.body);
      if (http.status !== 200) throw new Error('Private HTTP is not ready');
      const response = await probe('/health/ready', readinessBudget(deadline));
      const state = snapshot.parse(response.body);
      const roles = [state.consumer, state.publisher];
      const applicable = roles.filter(
        (entry) => entry.status !== 'not_applicable',
      );
      if (app.messaging ? applicable.length === 0 : applicable.length !== 0)
        throw new Error(
          'Messaging capability does not match consumer/publisher applicability',
        );
      if (
        response.status !== 200 ||
        applicable.some(
          (entry) =>
            entry.status !== 'ready' ||
            !entry.connected ||
            entry.reason !== null,
        )
      )
        throw new Error(
          `consumer=${state.consumer.status}; publisher=${state.publisher.status}`,
        );
      readinessBudget(deadline);
      if (!connected)
        throw new Error('Kong active target recovery has not been observed');
      console.log(
        `Publication readiness ${app.name}: approved within 60000 ms`,
      );
      return;
    } catch (error) {
      if (performance.now() < deadline) {
        const detail = error instanceof Error ? error.message : String(error);
        if (detail !== unmet)
          console.log(
            `Publication readiness ${app.name}: waiting for ${detail}`,
          );
        unmet = detail;
      }
    }
    await Bun.sleep(Math.max(0, Math.min(100, deadline - performance.now())));
  }
  throw new Error(
    `Publication readiness ${app.name} exhausted 60000 ms (elapsed=${String(Math.round(performance.now() - (deadline - 60_000)))} ms): ${unmet}`,
  );
}

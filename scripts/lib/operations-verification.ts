import { parseReadinessSnapshot } from '@starter/capabilities/readiness';
import { z } from 'zod';
import type { Artifact } from './operations-config';

const readiness = z.enum(['ready', 'not_ready', 'not_applicable', 'unknown']);
export const runtimeSchema = z.object({
  observedAt: z.string(),
  container: z.string(),
  image: z.string(),
  process: z.string(),
  http: readiness,
  messaging: readiness,
  readiness: z.unknown(),
  backlog: z.unknown(),
});
export type ApplicationRuntime = z.infer<typeof runtimeSchema>;

/** Interpret actual runtime evidence with the same readiness parser in every adapter. */
export function applicationRuntime(
  selected: Artifact,
  observation: {
    container: string;
    image: string;
    process: string;
    health?: unknown;
  },
): ApplicationRuntime {
  const runtime: ApplicationRuntime = {
    observedAt: new Date().toISOString(),
    container: observation.container,
    image: observation.image,
    process: observation.process,
    http: 'unknown',
    messaging: 'unknown',
    readiness: null,
    backlog: null,
  };
  if (runtime.process !== 'running' || runtime.image !== selected.image)
    return runtime;
  const result = z
    .object({ http: z.boolean(), readiness: z.unknown(), backlog: z.unknown() })
    .safeParse(observation.health);
  if (!result.success) return runtime;
  runtime.http = result.data.http ? 'ready' : 'not_ready';
  runtime.readiness = result.data.readiness;
  runtime.backlog = result.data.backlog;
  const snapshot = parseReadinessSnapshot(
    result.data.readiness,
    selected.declaration,
  );
  if (!snapshot.valid) return runtime;
  const roles = [
    snapshot.snapshot.consumer.status,
    snapshot.snapshot.publisher.status,
  ];
  runtime.messaging = roles.includes('not_ready')
    ? 'not_ready'
    : roles.every((role) => role === 'not_applicable')
      ? 'not_applicable'
      : 'ready';
  return runtime;
}
export interface VerificationClock {
  now: () => number;
  sleep: (milliseconds: number) => Promise<void>;
}
export const verificationClock: VerificationClock = {
  now: () => Date.now(),
  sleep: (milliseconds) => Bun.sleep(milliseconds),
};

/** One bounded candidate-verification window; dependency recovery continues inside the app. */
export async function waitForCandidate(
  observe: () => Promise<ApplicationRuntime>,
  record: (runtime: ApplicationRuntime) => void,
  signal: AbortSignal,
  clock: VerificationClock,
): Promise<ApplicationRuntime> {
  const deadline = clock.now() + 60_000;
  for (;;) {
    signal.throwIfAborted();
    const runtime = await observe();
    record(runtime);
    if (
      runtime.process === 'running' &&
      runtime.http === 'ready' &&
      ['ready', 'not_applicable'].includes(runtime.messaging)
    )
      return runtime;
    if (clock.now() >= deadline) return runtime;
    await clock.sleep(500);
  }
}

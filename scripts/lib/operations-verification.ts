import { z } from 'zod';
import type { Artifact } from './operations-config';

type Command = (
  args: string[],
  timeout?: number,
  cleanup?: boolean,
) => Promise<string>;
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

/** Probe the selected container even when its process or HTTP server is unavailable. */
export async function probeApplication(
  selected: Artifact,
  compose: Command,
  execute: Command,
  cleanup = false,
): Promise<ApplicationRuntime> {
  const container = await compose(
    ['ps', '--all', '-q', `app-${selected.declaration.name}`],
    10_000,
    cleanup,
  );
  const runtime: ApplicationRuntime = {
    observedAt: new Date().toISOString(),
    container,
    image: '',
    process: 'missing',
    http: 'unknown',
    messaging: 'unknown',
    readiness: null,
    backlog: null,
  };
  if (!container) return runtime;
  const inspected = z
    .object({ image: z.string(), process: z.string() })
    .parse(
      JSON.parse(
        await execute(
          [
            'docker',
            'inspect',
            '--format',
            '{"image":{{json .Config.Image}},"process":{{json .State.Status}}}',
            container,
          ],
          10_000,
          cleanup,
        ),
      ),
    );
  runtime.image = inspected.image;
  runtime.process = inspected.process;
  if (runtime.process !== 'running' || runtime.image !== selected.image)
    return runtime;
  try {
    const result = z
      .object({
        http: z.boolean(),
        readiness: z.unknown(),
        backlog: z.unknown(),
      })
      .parse(
        JSON.parse(
          await compose(
            [
              'exec',
              '-T',
              `app-${selected.declaration.name}`,
              'bun',
              '-e',
              `
        const get = async path => {
          try {
            const response = await fetch('http://127.0.0.1:3000/health/' + path, { signal: AbortSignal.timeout(2000) });
            return { ok: response.ok, body: await response.json() };
          } catch { return null; }
        };
        const [http, ready, backlog] = await Promise.all([get('ready/http'), get('ready'), get('backlog')]);
        console.log(JSON.stringify({http: http?.ok ?? false, readiness: ready?.body ?? null, backlog: backlog?.body ?? null}));
      `,
            ],
            5_000,
            cleanup,
          ),
        ),
      );
    runtime.http = result.http ? 'ready' : 'not_ready';
    runtime.readiness = result.readiness;
    runtime.backlog = result.backlog;
    const snapshot = z
      .object({
        service: z.literal(selected.declaration.name),
        consumer: z.object({ status: readiness }),
        publisher: z.object({ status: readiness }),
      })
      .safeParse(result.readiness);
    if (!snapshot.success) return runtime;
    const roles = [
      snapshot.data.consumer.status,
      snapshot.data.publisher.status,
    ];
    runtime.messaging = roles.includes('not_ready')
      ? 'not_ready'
      : roles.every((role) => role === 'not_applicable')
        ? 'not_applicable'
        : roles.includes('unknown')
          ? 'unknown'
          : 'ready';
  } catch {
    // Connection refusal and malformed responses are unavailable readiness, never success.
  }
  return runtime;
}

/** One bounded candidate-verification window; dependency recovery continues inside the app. */
export async function waitForCandidate(
  selected: Artifact,
  compose: Command,
  execute: Command,
  record: (runtime: ApplicationRuntime) => void,
  signal: AbortSignal,
): Promise<ApplicationRuntime> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    signal.throwIfAborted();
    const runtime = await probeApplication(selected, compose, execute);
    record(runtime);
    if (
      runtime.process === 'running' &&
      runtime.http === 'ready' &&
      ['ready', 'not_applicable'].includes(runtime.messaging)
    )
      return runtime;
    if (Date.now() >= deadline) return runtime;
    await Bun.sleep(500);
  }
}

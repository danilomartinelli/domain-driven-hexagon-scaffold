import { expect } from 'bun:test';
import { z } from 'zod';
import {
  assertTestEnvironment,
  readEnvironmentFile,
} from '../../database/environment';
import { runCommand } from '../../scripts/lib/command';
import { withCleanup } from '../../scripts/tests/cleanup';
import { user } from './test-server';

export async function eventually(
  check: () => Promise<void> | void,
): Promise<void> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      await check();
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await Bun.sleep(100);
    }
  }
}

export async function docker(args: string[]): Promise<string> {
  const result = await runCommand(['docker', ...args], {
    cwd: process.cwd(),
    timeout: 30_000,
  });
  if (result.code !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

export async function ownedContainer(service: string): Promise<string> {
  assertTestEnvironment();
  const file = process.env.DDH_ENVIRONMENT_FILE;
  if (!file) throw new Error('Missing manifest');
  const manifest = readEnvironmentFile(file);
  const id = await docker([
    'ps',
    '-q',
    '--filter',
    `label=com.docker.compose.project=${manifest.project}`,
    '--filter',
    `label=dev.starter.owner=${manifest.owner}`,
    '--filter',
    `label=com.docker.compose.service=${service}`,
  ]);
  if (!id || id.includes('\n')) throw new Error('Expected one owned container');
  return id;
}

async function waitForHealthy(container: string): Promise<void> {
  await eventually(async () => {
    expect(
      await docker([
        'inspect',
        '--format',
        '{{.State.Health.Status}}',
        container,
      ]),
    ).toBe('healthy');
  });
}

type ServiceFault = { service: string } & (
  { mode: 'unresponsive' } | { mode: 'stopped'; allowDataLoss?: true }
);

const containerSchema = z.tuple([
  z.object({
    State: z.object({ Running: z.boolean(), Paused: z.boolean() }),
    Mounts: z.array(z.object({ Type: z.string() })),
    HostConfig: z.object({
      Tmpfs: z.record(z.string(), z.string()).nullish(),
    }),
  }),
]);

/** Own the fault and its recovery; stopping tmpfs requires explicit data-loss intent. */
export async function withServiceFault<T>(
  fault: ServiceFault,
  scenario: () => T | Promise<T>,
): Promise<T> {
  const container = await ownedContainer(fault.service);
  const [inspection] = containerSchema.parse(
    JSON.parse(await docker(['inspect', container])),
  );
  if (!inspection.State.Running || inspection.State.Paused) {
    throw new Error(
      'Expected a running, unpaused container before injecting a fault',
    );
  }
  if (
    fault.mode === 'stopped' &&
    !fault.allowDataLoss &&
    (inspection.Mounts.some((mount) => mount.Type === 'tmpfs') ||
      Object.keys(inspection.HostConfig.Tmpfs ?? {}).length > 0)
  ) {
    throw new Error(
      'Stopping tmpfs loses data; use unresponsive or explicitly allowDataLoss',
    );
  }
  return withCleanup(async () => {
    await docker(
      fault.mode === 'unresponsive'
        ? ['pause', container]
        : ['stop', '--time', '3', container],
    );
    return scenario();
  }, [
    async () => {
      // Inspect after command failure too: Docker may have applied the fault before timing out.
      const [current] = containerSchema.parse(
        JSON.parse(await docker(['inspect', container])),
      );
      if (current.State.Paused) await docker(['unpause', container]);
      if (!current.State.Running) await docker(['start', container]);
      await waitForHealthy(container);
    },
  ]);
}

const logSchema = z.object({
  service: z.string(),
  operation: z.string(),
  eventId: z.string(),
  correlationId: z.string(),
});
export function eventLogs(service: typeof user): z.infer<typeof logSchema>[] {
  return service.output.split('\n').flatMap((line) => {
    try {
      const result = logSchema.safeParse(JSON.parse(line));
      return result.success ? [result.data] : [];
    } catch {
      return [];
    }
  });
}

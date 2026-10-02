import { expect } from 'bun:test';
import { z } from 'zod';
import {
  assertTestEnvironment,
  readEnvironmentFile,
} from '../../database/environment';
import { runCommand } from '../../scripts/lib/command';
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

export async function restore(container: string): Promise<void> {
  await docker(['start', container]);
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

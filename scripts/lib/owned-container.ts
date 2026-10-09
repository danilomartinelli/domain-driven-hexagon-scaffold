import { z } from 'zod';
import { runCommand } from './command';

/** Delete only the inspected container owned by this run; never delete volumes. */
async function removeContainer(container: {
  name: string;
  owner: string;
}): Promise<void> {
  if (!container.owner)
    throw new Error('An expected container owner is required');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(container.name))
    throw new Error('Invalid container name');
  const options = { cwd: process.cwd(), timeout: 15_000 };
  const inspection = await runCommand(
    ['docker', 'container', 'inspect', container.name],
    options,
  );
  if (
    inspection.code === 1 &&
    inspection.stderr.trim() ===
      `Error response from daemon: No such container: ${container.name}`
  )
    return;
  if (inspection.code !== 0)
    throw new Error(
      `Container inspection failed (${String(inspection.code)}): ${inspection.stderr}`,
    );
  const [inspected] = z
    .tuple([
      z.object({
        Id: z.string().regex(/^[a-f0-9]{64}$/),
        Config: z.object({
          Labels: z.record(z.string(), z.string()).nullable(),
        }),
      }),
    ])
    .parse(JSON.parse(inspection.stdout));
  if (inspected.Config.Labels?.['dev.starter.owner'] !== container.owner)
    throw new Error(
      `Refusing to remove ${container.name}: owner does not match this run`,
    );
  const removal = await runCommand(
    ['docker', 'rm', '-f', inspected.Id],
    options,
  );
  if (removal.code !== 0)
    throw new Error(
      `Container removal failed (${String(removal.code)}): ${removal.stderr}`,
    );
}

export class OwnedContainerCleanupError extends Error {}

export function isOwnedCleanupFailure(error: unknown): boolean {
  return (
    error instanceof OwnedContainerCleanupError ||
    (error instanceof AggregateError &&
      error.errors.some(isOwnedCleanupFailure))
  );
}

export async function removeOwnedContainer(container: {
  name: string;
  owner: string;
}): Promise<void> {
  try {
    await removeContainer(container);
  } catch (error) {
    throw new OwnedContainerCleanupError(
      error instanceof Error ? error.message : String(error),
      { cause: error },
    );
  }
}

import { isOwnedCleanupFailure } from './owned-container';
import {
  environmentPrefix,
  type ApplicationDeclaration,
} from '@starter/capabilities/declaration';
import type { PlatformImageRuntime } from './artifact-approval/ports';

/** Shared by approval and the assertion-based ordinary-startup image wrapper. */
export async function imagePlatform(
  runtime: PlatformImageRuntime,
  platform: string,
): Promise<{ platform: string; arch: string }> {
  const executed = await runtime.executedPlatform();
  if (
    !['linux/arm64', 'linux/amd64'].includes(platform) ||
    executed.platform !== 'linux' ||
    executed.arch !== (platform === 'linux/arm64' ? 'arm64' : 'x64')
  )
    throw new Error(
      'Image must execute as Linux on the requested architecture',
    );
  return executed;
}

export async function imageMigrations(
  app: ApplicationDeclaration,
  runtime: PlatformImageRuntime,
  signal?: AbortSignal,
): Promise<string[]> {
  const unmet: string[] = [];
  const check = async (
    condition: string,
    operation: () => Promise<boolean>,
  ) => {
    signal?.throwIfAborted();
    try {
      if (!(await operation())) unmet.push(condition);
    } catch (error) {
      if (isOwnedCleanupFailure(error)) throw error;
      signal?.throwIfAborted();
      unmet.push(
        `${condition}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    signal?.throwIfAborted();
  };
  if (app.persistence) {
    await check(
      'Owner migration up must succeed',
      async () => (await runtime.migrate('up')).code === 0,
    );
    await check(
      'Owner migration status must succeed',
      async () => (await runtime.migrate('status')).code === 0,
    );
    await check(
      'Cross-application migration must be refused',
      async () =>
        (await runtime.migrate('up', { DATABASE_APP: `${app.name}-other` }))
          .code !== 0,
    );
    await check(
      'Migration with runtime credentials must be refused',
      async () =>
        (
          await runtime.migrate('up', {
            [`${environmentPrefix(app.name)}_DB_MIGRATION_USERNAME`]: `${app.name.replaceAll('-', '_')}_runtime`,
          })
        ).code !== 0,
    );
  } else {
    await check(
      'A nonpersistent image must have no migration interface',
      async () => {
        const migration = await runtime.migrate('up');
        return (
          migration.code !== 0 && migration.stderr.includes('Script not found')
        );
      },
    );
  }
  return unmet;
}

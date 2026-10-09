import { randomUUID } from 'node:crypto';
import { discoverApplications } from '@starter/capabilities/declaration';
import { join } from 'node:path';
import { workspaceRoot } from '../database/environment';
import { buildImage } from './lib/image';
import { platformSchema, digestSchema } from './lib/publication';
import { distributionScenarioCommand } from './lib/distribution-scenarios';
import { runCommand } from './lib/command';
import { withCleanup } from './lib/cleanup';

const controller = new AbortController();
const interrupt = () => {
  controller.abort('SIGINT');
};
const terminate = () => {
  controller.abort('SIGTERM');
};
process.on('SIGINT', interrupt);
process.on('SIGTERM', terminate);
const cancellation = { signal: controller.signal, graceMs: 90_000 };

try {
  const platform = platformSchema.parse(process.env.DDH_IMAGE_PLATFORM);
  for (const app of discoverApplications(join(workspaceRoot, 'src/apps'))) {
    controller.signal.throwIfAborted();
    const tag = `ddh-distribution-${app.name}:${randomUUID()}`;
    await withCleanup(async () => {
      await buildImage(app.name, {
        platform,
        tag,
        execute: (args) =>
          runCommand(args, {
            cwd: workspaceRoot,
            timeout: 300_000,
            maxOutput: 1_000_000,
            cancellation,
          }),
      });
      const result = await runCommand(
        ['docker', 'image', 'inspect', '--format={{.Id}}', tag],
        { cwd: workspaceRoot, cancellation },
      );
      if (result.code !== 0) throw new Error(result.stderr);
      const image = digestSchema.parse(result.stdout.trim());
      const execute = async (args: string[], imageEnvironment = false) => {
        const result = await runCommand(args, {
          cwd: workspaceRoot,
          timeout: 600_000,
          cancellation,
          maxOutput: 2_000_000,
          env: {
            ...process.env,
            ...(imageEnvironment
              ? { DDH_IMAGE_PLATFORM: platform, DDH_VALIDATED_IMAGE: image }
              : {}),
          },
        });
        console.log(result.stdout + result.stderr);
        if (result.code !== 0)
          throw new Error(
            `Distribution image ${app.name} failed (${String(result.code)})`,
          );
      };
      await execute([
        'bun',
        'scripts/with-test-database.ts',
        `--app=${app.name}`,
        '--no-database-setup',
        '--',
        'bun',
        'scripts/publication.ts',
        'approve',
        app.name,
        `--image=${image}`,
        `--platform=${platform}`,
      ]);
      const scenarios = await distributionScenarioCommand(app.name);
      controller.signal.throwIfAborted();
      if (scenarios) await execute(scenarios, true);
      else
        console.log(
          `Distribution scenarios ${app.name}: no test-distribution target; artifact approval only`,
        );
    }, [
      async () => {
        const present = await runCommand(
          ['docker', 'image', 'ls', '--quiet', '--filter', `reference=${tag}`],
          { cwd: workspaceRoot },
        );
        if (present.code !== 0) throw new Error(present.stderr);
        if (present.stdout.trim()) {
          const removed = await runCommand(['docker', 'image', 'rm', tag], {
            cwd: workspaceRoot,
          });
          if (removed.code !== 0) throw new Error(removed.stderr);
        }
      },
    ]);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  process.off('SIGINT', interrupt);
  process.off('SIGTERM', terminate);
  if (controller.signal.aborted)
    process.exitCode = controller.signal.reason === 'SIGINT' ? 130 : 143;
}

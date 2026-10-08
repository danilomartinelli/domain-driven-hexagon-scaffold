import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { workspaceRoot } from '../../database/environment';
import { buildImage } from './image';
import { runCommand } from './command';
import {
  digestSchema,
  platformSchema,
  type PublicationPlan,
} from './publication';

/** No registry credentials or writes are needed to produce these validated archives. */
export async function preparePublication(
  plan: PublicationPlan,
  platform: string,
  output: string,
  signal?: AbortSignal,
): Promise<void> {
  platformSchema.parse(platform);
  const directory = resolve(workspaceRoot, output);
  mkdirSync(dirname(directory), { recursive: true });
  // A failed retry must never inherit an earlier approval.
  mkdirSync(directory);
  const cancellation = signal ? { signal, graceMs: 90_000 } : undefined;
  const command = async (args: string[], timeout = 60_000, cleanup = false) => {
    const result = await runCommand(args, {
      cwd: workspaceRoot,
      timeout,
      maxOutput: 1_000_000,
      cancellation: cleanup ? undefined : cancellation,
    });
    if (result.code !== 0)
      throw new Error(
        `${args[0]} failed (${String(result.code)}): ${result.stdout}${result.stderr}`,
      );
    return result.stdout.trim();
  };
  const host = (
    await command(['docker', 'info', '--format', '{{.Architecture}}'])
  ).trim();
  const hostArchitecture = /^(aarch64|arm64)$/.test(host)
    ? 'arm64'
    : /^(x86_64|amd64)$/.test(host)
      ? 'amd64'
      : undefined;
  if (!hostArchitecture)
    throw new Error('Unsupported Docker host architecture');
  const architecture = platform.split('/')[1];
  const execution = hostArchitecture === architecture ? 'native' : 'emulated';
  const artifacts: { name: string; image: string; id: string }[] = [];
  for (const app of plan.applications) {
    const tag = `ddh-publication-${app.name}:${randomUUID()}`;
    let failed = false;
    let failure: unknown;
    try {
      await buildImage(app.name, {
        platform,
        tag,
        labels: {
          'org.opencontainers.image.source': `https://github.com/${plan.repository}`,
          'org.opencontainers.image.revision': plan.revision,
        },
        execute: (args) =>
          runCommand(args, {
            cwd: workspaceRoot,
            timeout: 300_000,
            maxOutput: 1_000_000,
            cancellation,
          }),
      });
      const id = digestSchema.parse(
        await command(['docker', 'image', 'inspect', '--format={{.Id}}', tag]),
      );
      const log = join(directory, `${app.name}.log`);
      const suites =
        app.name === 'user' || app.name === 'wallet'
          ? [
              ['bun', 'run', 'nx', 'run', `${app.name}:test-distribution`],
              [
                'bun',
                'scripts/with-test-database.ts',
                `--app=${app.name}`,
                '--no-database-setup',
                '--',
                'bun',
                'test',
                `./scripts/tests/distribution-${app.name === 'user' ? '' : 'wallet-'}shutdown.test.ts`,
              ],
            ]
          : [];
      suites.unshift([
        'bun',
        'scripts/with-test-database.ts',
        `--app=${app.name}`,
        '--no-database-setup',
        '--',
        'bun',
        'scripts/tests/fixtures/image-capabilities.ts',
      ]);
      for (const args of suites) {
        const result = await runCommand(args, {
          cwd: workspaceRoot,
          timeout: 600_000,
          maxOutput: 2_000_000,
          cancellation,
          env: {
            ...process.env,
            DDH_IMAGE_PLATFORM: platform,
            DDH_VALIDATED_IMAGE: id,
            DDH_PUBLICATION_READINESS: 'true',
          },
          progress: { label: `validate ${app.name} ${platform}`, logPath: log },
        });
        writeFileSync(log, result.stdout + result.stderr, { flag: 'a' });
        if (result.code !== 0)
          throw new Error(
            `Image validation failed: ${app.name} ${platform}; ${log}\n${(result.stdout + result.stderr).slice(-8000)}`,
          );
      }
      // The fixture actually executes this ID, including its architecture probe.
      z.object({
        Os: z.literal('linux'),
        Architecture: z.literal(architecture),
      })
        .array()
        .length(1)
        .parse(JSON.parse(await command(['docker', 'image', 'inspect', id])));
      await command(
        [
          'docker',
          'image',
          'save',
          '--output',
          join(directory, `${app.name}.tar`),
          id,
        ],
        120_000,
      );
      artifacts.push({ ...app, id });
      console.log(
        `Validated ${app.name}: ${id}; ${platform}; ${execution} on ${hostArchitecture}`,
      );
    } catch (error) {
      failed = true;
      failure = error;
    }
    try {
      if (
        await command(
          ['docker', 'image', 'ls', '--quiet', '--filter', `reference=${tag}`],
          60_000,
          true,
        )
      )
        await command(['docker', 'image', 'rm', tag], 60_000, true);
    } catch (cleanupError) {
      if (failed)
        throw new AggregateError(
          [failure, cleanupError],
          'Image validation and cleanup failed',
          { cause: cleanupError },
        );
      throw cleanupError;
    }
    if (failed) throw failure;
  }
  signal?.throwIfAborted();
  writeFileSync(
    join(directory, 'validated.json'),
    JSON.stringify(
      { ...plan, platform, hostArchitecture, execution, artifacts },
      null,
      2,
    ) + '\n',
  );
}

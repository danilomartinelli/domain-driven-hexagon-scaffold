import { expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { environmentPrefix } from '@starter/capabilities/declaration';
import type { EnvironmentManifest } from '../../database/environment';
import { buildImage } from '../lib/image';
import { gatewayConfiguration } from '../lib/gateway';
import { imagePlatform, imageMigrations } from '../lib/image-contract';
import { dockerImageRuntime } from '../lib/platform-image-runtime';
import { runCommand, type CommandResult } from '../lib/command';
import { until } from './app-runtime-fixture';
import { withCleanup } from './cleanup';

interface ImageRuntime {
  url: string;
  stop: (expectedExit?: number | number[]) => Promise<void>;
  probe: (path: string) => Promise<{ status: number; body: unknown }>;
  databaseFault: (action: 'pause' | 'unpause') => Promise<void>;
  assertRuntimePrivileges: () => Promise<void>;
  assertMigrationContract: () => Promise<void>;
  start: (overrides?: Record<string, string>) => Promise<void>;
  migrate: (
    action: string,
    overrides?: Record<string, string>,
  ) => Promise<CommandResult>;
  cleanup: () => Promise<void>;
}

/** Assertion-based distribution wrapper; Docker placement belongs to the production adapter. */
export async function imageRuntime(
  app: string,
  manifest: EnvironmentManifest,
  runtime: Record<string, string>,
  migration: Record<string, string>,
  cwd: string,
): Promise<ImageRuntime> {
  const platform =
    process.env.DDH_IMAGE_PLATFORM ??
    `linux/${process.arch === 'arm64' ? 'arm64' : 'amd64'}`;
  const supplied = process.env.DDH_VALIDATED_IMAGE;
  if (supplied && !/^sha256:[a-f0-9]{64}$/.test(supplied))
    throw new Error('Validation requires an immutable local image ID');
  const tag =
    supplied ??
    (await buildImage(app, {
      platform,
      tag: `ddh-${app}-test:${randomUUID()}`,
    }));
  const declaration = manifest.topology?.find((entry) => entry.name === app);
  if (!declaration) throw new Error('Image application is not selected');
  const prefix = environmentPrefix(app);
  const adapter = dockerImageRuntime({
    app: declaration,
    manifest,
    image: tag,
    platform,
    runtime,
    migration,
    cwd,
  });
  const command = (args: string[], timeout = 30_000) =>
    runCommand(args, { cwd, timeout });
  const removeImage = async () => {
    if (supplied) return;
    const removed = await command(['docker', 'image', 'rm', tag]);
    expect(removed.code, removed.stderr).toBe(0);
  };
  try {
    const metadata = await imagePlatform(adapter, platform);
    const host = await command([
      'docker',
      'info',
      '--format',
      '{{.Architecture}}',
    ]);
    expect(host.code, host.stderr).toBe(0);
    console.log(
      `OCI execution ${app}: ${JSON.stringify(metadata)}; Docker host ${host.stdout.trim()}; ${(metadata.arch === 'arm64') === /arm64|aarch64/.test(host.stdout) ? 'native' : 'emulated'}`,
    );
  } catch (error) {
    await withCleanup(() => {
      throw error;
    }, [adapter.cleanup, removeImage]);
  }
  return {
    url: `http://127.0.0.1:${String(manifest.gateway?.proxyPort)}`,
    stop: async (expectedExit: number | number[] = 0) => {
      const stopped = await adapter.stop();
      await adapter.cleanup();
      expect(
        Array.isArray(expectedExit) ? expectedExit : [expectedExit],
      ).toContain(stopped.code);
    },
    assertRuntimePrivileges: async () => {
      const result = await adapter.executeRuntime([
        '-e',
        `
        import {Client} from 'pg';
        const value = (suffix) => process.env[${JSON.stringify(prefix + '_DB_')} + suffix];
        const client = new Client({host:value('HOST'),port:Number(value('PORT')),database:value('NAME'),user:value('USERNAME'),password:value('PASSWORD')});
        await client.connect();
        try { await client.query('CREATE TABLE forbidden_owner_operation (id integer)'); throw new Error('Runtime obtained owner privileges'); }
        catch(error) { if(error.code !== '42501') throw error; console.log('runtime-denied'); }
        finally { await client.end(); }
      `,
      ]);
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe('runtime-denied');
    },
    databaseFault: async (action: 'pause' | 'unpause') => {
      const found = await command([
        'docker',
        'ps',
        '-q',
        '--filter',
        `label=dev.starter.owner=${manifest.owner}`,
        '--filter',
        `label=com.docker.compose.project=${manifest.project}`,
        '--filter',
        `label=com.docker.compose.service=postgres-${app}`,
      ]);
      expect(found.code, found.stderr).toBe(0);
      const id = found.stdout.trim();
      expect(id).toMatch(/^[a-f0-9]+$/);
      const result = await command(['docker', action, id]);
      expect(result.code, result.stderr).toBe(0);
    },
    probe: adapter.probe,
    migrate: adapter.migrate,
    assertMigrationContract: async () => {
      expect(await imageMigrations(declaration, adapter)).toEqual([]);
    },
    start: async (overrides: Record<string, string> = {}) => {
      await adapter.start(30_000, overrides);
      await until(async () => {
        try {
          return (await adapter.probe('/health/live')).status === 200;
        } catch {
          return false;
        }
      });
      if (manifest.gateway) {
        const configured = await fetch(
          `http://127.0.0.1:${String(manifest.gateway.adminPort)}/config`,
          {
            method: 'POST',
            signal: AbortSignal.timeout(5000),
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              config: gatewayConfiguration(manifest, true),
            }),
          },
        );
        expect(configured.status, await configured.text()).toBe(201);
      }
      expect(await adapter.publishedPorts(30_000)).toBe('');
      expect(await adapter.hostReachable(2000)).toBe(false);
    },
    cleanup: () => withCleanup(adapter.cleanup, [removeImage]),
  };
}

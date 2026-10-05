import { expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { environmentPrefix } from '@starter/capabilities/declaration';
import type { EnvironmentManifest } from '../../database/environment';
import { buildImage } from '../lib/image';
import { gatewayConfiguration } from '../lib/gateway';
import { runCommand, type CommandResult } from '../lib/command';
import { removeOwnedContainer } from './owned-container';
import { until } from './app-runtime-fixture';
import { withCleanup } from './cleanup';

/** The existing distribution scenarios run unchanged against an unpublished container listener. */
interface ImageRuntime {
  url: string;
  stop: (expectedExit?: number | number[]) => Promise<void>;
  probe: (path: string) => Promise<{ status: number; body: unknown }>;
  databaseFault: (action: 'pause' | 'unpause') => Promise<void>;
  assertRuntimePrivileges: () => Promise<void>;
  start: (overrides?: Record<string, string>) => Promise<void>;
  migrate: (
    action: string,
    overrides?: Record<string, string>,
  ) => Promise<CommandResult>;
  cleanup: () => Promise<void>;
}

export async function imageRuntime(
  app: string,
  manifest: EnvironmentManifest,
  runtime: Record<string, string>,
  migration: Record<string, string>,
  cwd: string,
): Promise<ImageRuntime> {
  const platform = process.env.DDH_IMAGE_PLATFORM;
  const tag = await buildImage(app, {
    platform,
    tag: `ddh-${app}-test:${randomUUID()}`,
  });
  const name = `${manifest.project}-${app}-artifact`;
  const declaration = manifest.topology?.find((entry) => entry.name === app);
  if (!declaration) throw new Error('Image application is not selected');
  const prefix = environmentPrefix(app);
  const network =
    manifest.databases.length || manifest.broker || manifest.gateway
      ? `${manifest.project}_default`
      : 'none';
  const command = (args: string[], timeout = 30_000) =>
    runCommand(args, { cwd, timeout });
  const settings = (env: Record<string, string>) => ({
    ...env,
    ...(declaration.persistence
      ? {
          [`${prefix}_DB_HOST`]: `postgres-${app}`,
          [`${prefix}_DB_PORT`]: '5432',
        }
      : {}),
    ...(declaration.messaging && manifest.broker
      ? {
          RABBITMQ_HOST: 'rabbitmq',
          RABBITMQ_PORT: '5672',
          [`${prefix}_RABBITMQ_URL`]: `amqp://${encodeURIComponent(manifest.broker.username)}:${encodeURIComponent(manifest.broker.password)}@rabbitmq:5672/${encodeURIComponent(manifest.broker.vhost)}`,
        }
      : {}),
  });
  const variables = (env: Record<string, string>) =>
    Object.entries(env)
      .filter(([key]) => key !== 'PATH')
      .flatMap(([key, value]) => ['--env', `${key}=${value}`]);
  const base = [
    'docker',
    'run',
    '--network',
    network,
    '--label',
    `dev.starter.owner=${manifest.owner}`,
    ...(platform ? ['--platform', platform] : []),
  ];
  const oneShot = (args: string[], timeout = 30_000) => {
    const commandName = `${name}-command-${randomUUID()}`;
    return withCleanup(
      () => command([...base, '--rm', '--name', commandName, ...args], timeout),
      [
        () =>
          removeOwnedContainer({ name: commandName, owner: manifest.owner }),
      ],
    );
  };
  let running = false;
  const stop = async (expectedExit: number | number[] = 0) => {
    if (!running) return;
    const stopped = await command(
      ['docker', 'stop', '--time=20', name],
      25_000,
    );
    expect(stopped.code, stopped.stderr).toBe(0);
    const inspected = await command([
      'docker',
      'inspect',
      '--format',
      '{{.State.ExitCode}}',
      name,
    ]);
    const logs = await command(['docker', 'logs', name]);
    expect(inspected.code, inspected.stderr).toBe(0);
    expect(logs.code, logs.stderr).toBe(0);
    expect(
      Array.isArray(expectedExit) ? expectedExit : [expectedExit],
      logs.stdout + logs.stderr,
    ).toContain(Number(inspected.stdout.trim()));
    await removeOwnedContainer({ name, owner: manifest.owner });
    running = false;
  };
  const removeImage = async () => {
    const removed = await command(['docker', 'image', 'rm', tag]);
    expect(removed.code, removed.stderr).toBe(0);
  };
  try {
    const metadata = await oneShot([
      tag,
      '-e',
      'console.log(JSON.stringify({platform:process.platform,arch:process.arch}))',
    ]);
    expect(metadata.code, metadata.stderr).toBe(0);
    expect(JSON.parse(metadata.stdout)).toEqual({
      platform: 'linux',
      arch: platform
        ? platform === 'linux/arm64'
          ? 'arm64'
          : 'x64'
        : process.arch,
    });
    const host = await command([
      'docker',
      'info',
      '--format',
      '{{.Architecture}}',
    ]);
    expect(host.code, host.stderr).toBe(0);
    console.log(
      `OCI execution ${app}: ${metadata.stdout.trim()}; Docker host ${host.stdout.trim()}; ${metadata.stdout.includes('arm64') === /arm64|aarch64/.test(host.stdout) ? 'native' : 'emulated'}`,
    );
  } catch (error) {
    await withCleanup(() => {
      throw error;
    }, [removeImage]);
  }
  return {
    url: `http://127.0.0.1:${String(manifest.gateway?.proxyPort)}`,
    stop,
    assertRuntimePrivileges: async () => {
      const result = await oneShot([
        ...variables(settings(runtime)),
        tag,
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
    databaseFault: async (action) => {
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
    probe: async (path) => {
      const result = await command([
        'docker',
        'exec',
        name,
        'bun',
        '-e',
        `const response = await fetch(${JSON.stringify(`http://127.0.0.1:${String(manifest.applicationPorts[app])}${path}`)}, {signal:AbortSignal.timeout(10000)}); console.log(JSON.stringify({status:response.status,body:await response.json()}));`,
      ]);
      expect(result.code, result.stderr).toBe(0);
      return z
        .object({ status: z.number(), body: z.unknown() })
        .parse(JSON.parse(result.stdout));
    },
    migrate: (action: string, overrides: Record<string, string> = {}) =>
      oneShot(
        [
          ...variables({ ...settings(migration), ...overrides }),
          tag,
          'run',
          `migration:${action}`,
        ],
        60_000,
      ),
    start: async (overrides: Record<string, string> = {}) => {
      if (running) throw new Error('Image already running');
      const started = await command([
        ...base,
        '--detach',
        '--name',
        name,
        ...(network === 'none' ? [] : ['--network-alias', `app-${app}`]),
        ...variables({ ...settings(runtime), ...overrides }),
        tag,
      ]);
      expect(started.code, started.stderr).toBe(0);
      running = true;
      await until(async () => {
        const live = await command([
          'docker',
          'exec',
          name,
          'bun',
          '-e',
          `process.exit((await fetch('http://127.0.0.1:${String(manifest.applicationPorts[app])}/health/live')).ok ? 0 : 1)`,
        ]);
        return live.code === 0;
      });
      if (manifest.gateway) {
        const configured = await fetch(
          `http://127.0.0.1:${String(manifest.gateway.adminPort)}/config`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              config: gatewayConfiguration(manifest, true),
            }),
          },
        );
        expect(configured.status, await configured.text()).toBe(201);
      }
      const published = await command(['docker', 'port', name]);
      expect(published.code, published.stderr).toBe(0);
      expect(published.stdout).toBe('');
      expect(
        await fetch(
          `http://127.0.0.1:${String(manifest.applicationPorts[app])}/health/live`,
        ).then(
          () => true,
          () => false,
        ),
      ).toBe(false);
      // Wait for Kong's active HTTP healthcheck, independently of messaging readiness.
      if (declaration.routes?.length)
        await until(
          async () =>
            (
              await fetch(
                `http://127.0.0.1:${String(manifest.gateway?.proxyPort)}/${app}/graphql`,
                {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ query: '{ __typename }' }),
                },
              )
            ).status === 200,
        );
    },
    cleanup: () =>
      withCleanup(
        () => removeOwnedContainer({ name, owner: manifest.owner }),
        [removeImage],
      ),
  };
}

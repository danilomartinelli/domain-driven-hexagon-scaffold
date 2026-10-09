import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  environmentPrefix,
  type ApplicationDeclaration,
} from '@starter/capabilities/declaration';
import {
  environmentVariables,
  workspaceRoot,
  type EnvironmentManifest,
} from '../../database/environment';
import { runCommand, type CommandResult } from './command';
import { withCleanup } from './cleanup';
import { removeOwnedContainer } from './owned-container';
import { gatewayNames } from './gateway';
import type { PlatformImageRuntime } from './artifact-approval/ports';

/** Owns Docker placement and command containers for one exact platform image. */
export interface DockerImageRuntime extends PlatformImageRuntime {
  start: (
    timeout?: number,
    overrides?: Record<string, string>,
  ) => Promise<void>;
  probe: (
    path: string,
    timeout?: number,
  ) => Promise<{ status: number; body: unknown }>;
  migrate: (
    action: string,
    overrides?: Record<string, string>,
  ) => Promise<CommandResult>;
  executeRuntime: (args: string[]) => Promise<CommandResult>;
}

export function dockerImageRuntime(options: {
  app: ApplicationDeclaration;
  image: string;
  platform: string;
  manifest: EnvironmentManifest;
  signal?: AbortSignal;
  runtime?: Record<string, string>;
  migration?: Record<string, string>;
  cwd?: string;
}): DockerImageRuntime {
  const { app, image, platform, manifest, signal } = options;
  const prefix = environmentPrefix(app.name);
  const name = `${manifest.project}-${app.name}-artifact`;
  const owned = new Set<string>();
  const network =
    manifest.databases.length || manifest.broker || manifest.gateway
      ? `${manifest.project}_default`
      : 'none';
  const settings: Record<string, string> = {};
  for (const [key, value] of Object.entries(environmentVariables(manifest, {})))
    if (
      value !== undefined &&
      (key.startsWith(`${prefix}_`) || key.startsWith('RABBITMQ_'))
    )
      settings[key] = value;
  const migration = options.migration ?? settings;
  const runtime = options.runtime ?? {
    NODE_ENV: 'production',
    ...Object.fromEntries(
      Object.entries(settings).filter(([key]) => !key.includes('_MIGRATION_')),
    ),
  };
  const placed = (env: Record<string, string>) => ({
    ...env,
    ...(app.persistence
      ? {
          [`${prefix}_DB_HOST`]: `postgres-${app.name}`,
          [`${prefix}_DB_PORT`]: '5432',
        }
      : {}),
    ...(app.messaging && manifest.broker
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
    '--platform',
    platform,
  ];
  const command = async (args: string[], timeout = 30_000) => {
    signal?.throwIfAborted();
    const result = await runCommand(args, {
      cwd: options.cwd ?? workspaceRoot,
      timeout,
      signal,
    });
    signal?.throwIfAborted();
    return result;
  };
  const successful = async (args: string[], timeout = 30_000) => {
    const result = await command(args, timeout);
    if (result.code !== 0)
      throw new Error(
        `Image command failed (${String(result.code)}): ${result.stderr}`,
      );
    return result.stdout;
  };
  const oneShot = (args: string[], timeout = 30_000) => {
    const commandName = `${name}-command-${randomUUID()}`;
    owned.add(commandName);
    return withCleanup(
      () => command([...base, '--rm', '--name', commandName, ...args], timeout),
      [
        async () => {
          await removeOwnedContainer({
            name: commandName,
            owner: manifest.owner,
          });
          owned.delete(commandName);
        },
      ],
    );
  };
  let running = false;
  const adapter = {
    executedPlatform: async () => {
      const result = await oneShot([
        image,
        '-e',
        'console.log(JSON.stringify({platform:process.platform,arch:process.arch}))',
      ]);
      if (result.code !== 0)
        throw new Error(`Platform execution failed: ${result.stderr}`);
      return z
        .object({ platform: z.string(), arch: z.string() })
        .parse(JSON.parse(result.stdout));
    },
    migrate: (action: string, overrides: Record<string, string> = {}) =>
      oneShot(
        [
          ...variables({ ...placed(migration), ...overrides }),
          image,
          'run',
          `migration:${action}`,
        ],
        60_000,
      ),
    start: async (timeout = 30_000, overrides: Record<string, string> = {}) => {
      if (running) throw new Error('Image already running');
      owned.add(name);
      await successful(
        [
          ...base,
          '--detach',
          '--name',
          name,
          ...(network === 'none'
            ? []
            : [
                '--network-alias',
                gatewayNames(app, manifest.applicationPorts[app.name])
                  .privateHost,
              ]),
          ...variables({ ...placed(runtime), ...overrides }),
          image,
        ],
        timeout,
      );
      running = true;
    },
    publishedPorts: (timeout: number) =>
      successful(['docker', 'port', name], timeout),
    hostReachable: (timeout: number) =>
      fetch(
        `http://127.0.0.1:${String(manifest.applicationPorts[app.name])}/health/live`,
        {
          signal: AbortSignal.any([
            AbortSignal.timeout(timeout),
            ...(signal ? [signal] : []),
          ]),
        },
      ).then(
        () => true,
        () => {
          signal?.throwIfAborted();
          return false;
        },
      ),
    probe: async (path: string, timeout = 30_000) => {
      const stdout = await successful(
        [
          'docker',
          'exec',
          name,
          'bun',
          '-e',
          `const response = await fetch(${JSON.stringify(`http://127.0.0.1:${String(manifest.applicationPorts[app.name])}`)} + ${JSON.stringify(path)}, {signal:AbortSignal.timeout(${String(Math.min(10_000, timeout))})}); console.log(JSON.stringify({status:response.status,body:await response.json()}));`,
        ],
        timeout,
      );
      return z
        .object({ status: z.number(), body: z.unknown() })
        .parse(JSON.parse(stdout));
    },
    stop: async () => {
      if (!running) return { code: 0 };
      await successful(['docker', 'stop', '--time=20', name], 25_000);
      const code = Number(
        (
          await successful([
            'docker',
            'inspect',
            '--format',
            '{{.State.ExitCode}}',
            name,
          ])
        ).trim(),
      );
      await removeOwnedContainer({ name, owner: manifest.owner });
      owned.delete(name);
      running = false;
      return { code };
    },
    cleanup: () =>
      withCleanup(
        () => undefined,
        [...owned].map(
          (container) => () =>
            removeOwnedContainer({ name: container, owner: manifest.owner }),
        ),
      ),
    executeRuntime: (args: string[]) =>
      oneShot([...variables(placed(runtime)), image, ...args]),
  } satisfies DockerImageRuntime & {
    executeRuntime(args: string[]): ReturnType<typeof oneShot>;
  };
  return adapter;
}

import { expect } from 'bun:test';
import type { Subprocess } from 'bun';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import type { Options } from 'amqplib';
import request from 'supertest';
import { z } from 'zod';
import {
  environmentPrefix,
  runtimeRole,
} from '@starter/capabilities/declaration';
import {
  assertTestEnvironment,
  readEnvironmentFile,
} from '../../database/environment';
import { runCommand, type CommandResult } from '../lib/command';
import { withCleanup } from './cleanup';
import { imageRuntime } from './image-runtime';

const root = new URL('../../', import.meta.url).pathname;

export function distributionBroker(): Options.Connect {
  return {
    hostname: process.env.RABBITMQ_HOST,
    port: Number(process.env.RABBITMQ_PORT),
    username: process.env.RABBITMQ_USERNAME,
    password: process.env.RABBITMQ_PASSWORD,
    vhost: process.env.RABBITMQ_VHOST,
  };
}

export interface DistributionFixture {
  owner: pg.Client;
  http: ReturnType<typeof request>;
  graphqlPath: string;
  migrate: (
    action: string,
    overrides?: Record<string, string>,
  ) => Promise<CommandResult>;
  start: (overrides?: Record<string, string>) => Promise<void>;
  stop: (expectedExit?: number | number[]) => Promise<void>;
  probe?: (path: string) => Promise<{ status: number; body: unknown }>;
  databaseFault?: (action: 'pause' | 'unpause') => Promise<void>;
}

export async function until(
  check: () => Promise<boolean>,
  timeout = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() >= deadline)
      throw new Error('Distribution condition timed out');
    await Bun.sleep(50);
  }
}

const upstreamHealth = z.object({
  data: z.array(
    z.object({ data: z.object({ addresses: z.unknown() }).optional() }),
  ),
});

/**
 * Kong lists resolved target addresses. A failed lookup reports `{}`, and a
 * balancer that is not built yet omits the target's health data.
 */
export function kongResolved(body: unknown): boolean {
  return upstreamHealth.parse(body).data.some(({ data }) => {
    const addresses = data?.addresses;
    return Array.isArray(addresses) && addresses.length > 0;
  });
}

export async function withDistribution(
  app: 'user' | 'wallet',
  use: (fixture: DistributionFixture) => Promise<void>,
): Promise<void> {
  assertTestEnvironment();
  const file = process.env.DDH_ENVIRONMENT_FILE;
  if (!file) throw new Error('Missing owned manifest');
  const manifest = readEnvironmentFile(file);
  expect(manifest.databases.map((db) => db.app)).toEqual([app]);
  const containers = await runCommand(
    [
      'docker',
      'ps',
      '--filter',
      `label=dev.starter.owner=${manifest.owner}`,
      '--format',
      '{{.Label "com.docker.compose.service"}}',
    ],
    { cwd: root },
  );
  expect(containers.code).toBe(0);
  expect(containers.stdout.trim().split('\n').sort()).toEqual([
    'gateway',
    `postgres-${app}`,
    'rabbitmq',
  ]);
  const db = manifest.databases[0];
  const directory = mkdtempSync(join(tmpdir(), `starter-${app}-delivery-`));
  const artifact = join(directory, app);
  const prefix = `${environmentPrefix(app)}_`;
  const runtime: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    NODE_ENV: 'production',
    NO_COLOR: '1',
  };
  const migration = { ...runtime };
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key.startsWith(prefix)) {
      migration[key] = value;
      if (!key.startsWith(`${prefix}DB_MIGRATION_`)) runtime[key] = value;
    }
    if (key.startsWith('RABBITMQ_')) runtime[key] = value;
  }
  const owner = new pg.Client({
    host: db.host,
    port: db.port,
    database: db.database,
    user: db.username,
    password: db.password,
  });
  let child: Subprocess<'ignore', 'pipe', 'pipe'> | undefined;
  let output = '';
  const logs: Promise<void>[] = [];
  let image: Awaited<ReturnType<typeof imageRuntime>> | undefined;
  const collect = async (stream: ReadableStream<Uint8Array>) => {
    for await (const chunk of stream)
      output = (output + new TextDecoder().decode(chunk)).slice(-32_000);
  };
  const stop = async (expectedExit?: number | number[]) => {
    if (image) return image.stop(expectedExit);
    const running = child;
    if (!running) return;
    child = undefined;
    running.kill('SIGTERM');
    const timer = setTimeout(() => {
      running.kill('SIGKILL');
    }, 20_000);
    try {
      await running.exited;
      await Promise.all(logs);
    } finally {
      clearTimeout(timer);
    }
  };
  const url = `http://127.0.0.1:${runtime[`${prefix}HTTP_PORT`]}`;
  const migrate = (command: string, overrides: Record<string, string> = {}) =>
    image
      ? image.migrate(command, overrides)
      : runCommand(
          [process.execPath, '--no-env-file', 'run', `migration:${command}`],
          {
            cwd: artifact,
            env: { ...migration, ...overrides },
            timeout: 60_000,
          },
        );
  await withCleanup(async () => {
    if (process.env.DDH_VALIDATED_IMAGE || process.env.DDH_IMAGE_PLATFORM) {
      image = await imageRuntime(app, manifest, runtime, migration, directory);
    } else {
      const packaged = await runCommand(
        [
          process.execPath,
          '--no-env-file',
          'scripts/distribute.ts',
          app,
          `--output=${artifact}`,
        ],
        { cwd: root, timeout: 60_000 },
      );
      expect(packaged, packaged.stderr).toMatchObject({ code: 0 });
    }
    await owner.connect();
    expect(
      (
        await owner.query(
          "SELECT tablename FROM pg_tables WHERE schemaname = 'public'",
        )
      ).rows,
    ).toEqual([]);
    if (image) {
      if (!manifest.gateway) throw new Error('Missing owned gateway');
      const admin = `http://127.0.0.1:${String(manifest.gateway.adminPort)}`;
      await image.start();
      // HTTP readiness fails before migrations, so Kong's active probe rejects
      // proxied requests. Wait only until Kong resolves the target, so the
      // immediate teardown cannot race its asynchronous initial DNS lookup.
      let observed = 'no response';
      await until(async () => {
        let status: number;
        let body: unknown;
        try {
          const response = await fetch(`${admin}/upstreams/app-${app}/health`, {
            signal: AbortSignal.timeout(1000),
          });
          status = response.status;
          body = await response.json();
        } catch (error: unknown) {
          observed = String(error);
          return false;
        }
        observed = `${String(status)} ${JSON.stringify(body)}`;
        return status === 200 && kongResolved(body);
      }, 60_000).catch((error: unknown) => {
        throw new Error(`Kong did not resolve app-${app}: ${observed}`, {
          cause: error,
        });
      });
      await image.stop();
      expect(
        (
          await owner.query(
            "SELECT tablename FROM pg_tables WHERE schemaname = 'public'",
          )
        ).rows,
      ).toEqual([]);
    }
    const status = await migrate('status');
    expect(status, status.stderr).toMatchObject({ code: 0 });
    expect(status.stdout).toContain('pending');
    const migrated = await migrate('up');
    expect(migrated, migrated.stderr).toMatchObject({ code: 0 });
    await image?.assertRuntimePrivileges();
    const denied = await migrate('up', {
      [`${prefix}DB_MIGRATION_USERNAME`]: runtimeRole(app),
      [`${prefix}DB_MIGRATION_PASSWORD`]: runtime[`${prefix}DB_PASSWORD`],
    });
    expect(denied.code).toBe(1);
    expect(denied.stderr).toContain('Migrations require the owner role');
    const history = await migrate('status');
    expect(history.code).toBe(0);
    expect(history.stdout).toContain('applied');
    const other = app === 'user' ? 'wallet' : 'user';
    const refused = await migrate('up', { DATABASE_APP: other });
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain(`This distribution owns only ${app}`);
    await use({
      owner,
      http: request(image?.url ?? url),
      graphqlPath: image ? `/${app}/graphql` : '/graphql',
      migrate,
      probe: image?.probe,
      databaseFault: image?.databaseFault,
      stop,
      start: async (overrides = {}) => {
        if (image) {
          await image.start(overrides);
          // These User/Wallet scenarios own their GraphQL contract. Generic
          // image preparation must never invent this business request.
          // Replacing the pre-migration container can leave Kong with a failed
          // DNS lookup; its balancer retries that lookup after 30 seconds.
          const gateway = image.url;
          await until(async () => {
            try {
              return (
                (
                  await fetch(`${gateway}/${app}/graphql`, {
                    method: 'POST',
                    signal: AbortSignal.timeout(1000),
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ query: '{ __typename }' }),
                  })
                ).status === 200
              );
            } catch {
              return false;
            }
          }, 60_000);
          return;
        }
        if (child) throw new Error('Distribution already running');
        output = '';
        child = Bun.spawn([process.execPath, '--no-env-file', 'run', 'start'], {
          cwd: artifact,
          env: { ...runtime, ...overrides },
          stdin: 'ignore',
          stdout: 'pipe',
          stderr: 'pipe',
        });
        logs.push(collect(child.stdout), collect(child.stderr));
        await until(async () => {
          if (child?.exitCode !== null)
            throw new Error(`Distribution exited: ${output}`);
          try {
            return (
              await fetch(`${url}/health/live`, {
                signal: AbortSignal.timeout(1_000),
              })
            ).ok;
          } catch {
            return false;
          }
        }).catch((error: unknown) => {
          throw new Error(`${String(error)}\n${output}`);
        });
      },
    }).catch((error: unknown) => {
      throw new Error(`${String(error)}\n${output}`);
    });
    await stop();
    const rollback = await migrate('down');
    expect(rollback, rollback.stderr).toMatchObject({ code: 0 });
    expect((await migrate('status')).stdout).toContain('pending');
    const reapplied = await migrate('up');
    expect(reapplied, reapplied.stderr).toMatchObject({ code: 0 });
  }, [
    () =>
      withCleanup(
        () => withCleanup(stop, [() => owner.end()]),
        [
          () =>
            withCleanup(async () => {
              await image?.cleanup();
            }, [
              () => {
                rmSync(directory, { recursive: true, force: true });
              },
            ]),
        ],
      ),
  ]);
}

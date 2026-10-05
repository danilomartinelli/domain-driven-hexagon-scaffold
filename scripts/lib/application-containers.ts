import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { environmentPrefix } from '@starter/capabilities/declaration';
import { selectedApplications } from '../../database/topology';
import {
  environmentLocation,
  environmentVariables,
  needsGateway,
  workspaceRoot,
  type EnvironmentManifest,
} from '../../database/environment';
import { buildImage } from './image';
import { commandSession } from './session';
import { verifyEnvironmentOwnership } from './ownership';

export function applicationDebugPort(name: string, offset = 0): number {
  const port =
    process.env.DDH_DEBUG_PORT === undefined
      ? 6499 + selectedApplications().findIndex((app) => app.name === name)
      : Number(process.env.DDH_DEBUG_PORT) + offset;
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error(
      'DDH_DEBUG_PORT must select valid TCP ports for every application',
    );
  return port;
}

export function applicationContainer(
  manifest: EnvironmentManifest,
  name: string,
  mode = 'watch',
  debugPort?: number,
): Record<string, unknown> {
  const app = manifest.topology?.find((entry) => entry.name === name);
  if (!app) throw new Error(`Application is not selected: ${name}`);
  const prefix = environmentPrefix(name);
  const defaults = environmentVariables(manifest, {});
  const settings = environmentVariables(manifest);
  const env: Record<string, string> = {
    NODE_ENV: process.env.NODE_ENV ?? 'development',
  };
  for (const [key, value] of Object.entries(settings)) {
    if (
      value !== undefined &&
      (key.startsWith(`${prefix}_`) ||
        (app.messaging && key.startsWith('RABBITMQ_'))) &&
      !key.includes('_MIGRATION_')
    )
      env[key] = value;
  }
  if (app.persistence) {
    if (
      env[`${prefix}_DB_HOST`] === defaults[`${prefix}_DB_HOST`] &&
      env[`${prefix}_DB_PORT`] === defaults[`${prefix}_DB_PORT`]
    ) {
      env[`${prefix}_DB_HOST`] = `postgres-${name}`;
      env[`${prefix}_DB_PORT`] = '5432';
    }
  }
  if (app.messaging && manifest.broker) {
    if (
      env.RABBITMQ_HOST === defaults.RABBITMQ_HOST &&
      env.RABBITMQ_PORT === defaults.RABBITMQ_PORT
    ) {
      env.RABBITMQ_HOST = 'rabbitmq';
      env.RABBITMQ_PORT = '5672';
    }
    if (env[`${prefix}_RABBITMQ_URL`] === defaults[`${prefix}_RABBITMQ_URL`])
      env[`${prefix}_RABBITMQ_URL`] =
        `amqp://${encodeURIComponent(manifest.broker.username)}:${encodeURIComponent(manifest.broker.password)}@rabbitmq:5672/${encodeURIComponent(manifest.broker.vhost)}`;
    delete env.RABBITMQ_MANAGEMENT_URL;
  }
  const dependencies = z
    .array(z.string())
    .parse(
      JSON.parse(
        readFileSync(
          join(workspaceRoot, 'src/apps', name, 'distribution.json'),
          'utf8',
        ),
      ),
    );
  const workspacePackages = dependencies.filter(
    (dependency) =>
      dependency.startsWith('@starter/') &&
      existsSync(join(workspaceRoot, 'src/packages', dependency.slice(9))),
  );
  return {
    image: `${manifest.project}-${name}:development`,
    profiles: ['applications'],
    labels: { 'dev.starter.owner': manifest.owner },
    stop_grace_period: '20s',
    command: [
      ...(mode === 'debug' ? ['--inspect=0.0.0.0:6499/inspect'] : []),
      ...(mode !== 'serve' ? ['--watch'] : []),
      'app/main.ts',
    ],
    environment: Object.fromEntries(
      Object.entries(env).map(([key, value]) => [
        key,
        value.replaceAll('$', () => '$$'),
      ]),
    ),
    volumes: [
      `${join(workspaceRoot, 'src/apps', name)}:/app/app:ro`,
      ...workspacePackages.map(
        (dependency) =>
          `${join(workspaceRoot, 'src/packages', dependency.slice(9))}:/app/node_modules/${dependency}:ro`,
      ),
    ],
    ...(mode === 'debug'
      ? { ports: [`127.0.0.1:${String(debugPort ?? 6499)}:6499`] }
      : {}),
    healthcheck: {
      test: [
        'CMD',
        'bun',
        '-e',
        `process.exit((await fetch('http://127.0.0.1:${String(manifest.applicationPorts[name])}/health/live')).ok ? 0 : 1)`,
      ],
      interval: '2s',
      timeout: '3s',
      retries: 30,
    },
  };
}

/** The attached supervisor owns only these app containers; prepared infrastructure survives it. */
export async function runApplicationContainers(
  manifest: EnvironmentManifest,
  names: string[],
  mode: string,
): Promise<number> {
  const debugPorts = new Map(
    mode === 'debug'
      ? names.map((name, index) => [name, applicationDebugPort(name, index)])
      : [],
  );
  const location = environmentLocation(manifest.environment, manifest.run);
  const logPath = join(location.directory, 'applications.log');
  const session = commandSession(workspaceRoot, logPath, {
    ...process.env,
    COMPOSE_DISABLE_ENV_FILE: '1',
    COMPOSE_PROFILES: '',
  });
  const compose = [
    'docker',
    'compose',
    '--project-name',
    manifest.project,
    '--file',
    join(location.directory, 'compose.json'),
  ];
  const services = names.map((name) => `app-${name}`);
  let started = false;
  let code = 1;
  const inspect = async (args: string[]) => {
    const result = await session.execute(args, {
      capture: true,
      timeout: 15_000,
      echo: false,
    });
    if (result.code !== 0)
      throw new Error('Container ownership inspection failed');
    return result.stdout.trim();
  };
  try {
    await verifyEnvironmentOwnership(manifest, inspect, true);
    for (const name of names) {
      const existing = await inspect([
        'docker',
        'ps',
        '-q',
        '--filter',
        `label=com.docker.compose.project=${manifest.project}`,
        '--filter',
        `label=com.docker.compose.service=app-${name}`,
      ]);
      if (existing)
        throw new Error(
          `Application already running in this environment: ${name}`,
        );
      await buildImage(name, {
        tag: `${manifest.project}-${name}:development`,
        execute: (args) =>
          session.execute(args, {
            capture: true,
            timeout: 300_000,
            echo: false,
          }),
      });
    }
    // This override belongs to this supervisor, so independently started apps do not rewrite each other's mode.
    const override = join(
      location.directory,
      `applications-${names.join('-')}.json`,
    );
    writeFileSync(
      override,
      JSON.stringify({
        services: Object.fromEntries(
          names.map((name) => [
            `app-${name}`,
            applicationContainer(manifest, name, mode, debugPorts.get(name)),
          ]),
        ),
      }),
      { mode: 0o600 },
    );
    compose.push('--file', override);
    started = true;
    const up = await session.execute(
      [
        ...compose,
        'up',
        '--detach',
        '--no-deps',
        '--wait',
        '--wait-timeout',
        '60',
        ...services,
      ],
      { timeout: 90_000 },
    );
    code = up.code;
    if (up.code !== 0)
      throw new Error(
        `Application container startup failed (${String(up.code)})`,
      );
    // Reload after service DNS is registered; active probes use HTTP readiness.
    if (needsGateway(manifest)) {
      const reload = await session.execute([
        ...compose,
        'up',
        '--detach',
        '--no-deps',
        '--force-recreate',
        '--wait',
        'gateway',
      ]);
      code = reload.code;
      if (reload.code !== 0)
        throw new Error(`Gateway reload failed (${String(reload.code)})`);
    }
    session.log('Application containers attached');
    const followed = await session.execute(
      [
        ...compose,
        'up',
        '--no-recreate',
        '--no-deps',
        '--abort-on-container-exit',
        '--timeout',
        '20',
        '--no-color',
        ...services,
      ],
      { timeout: null, gracePeriod: 25_000 },
    );
    code = followed.code;
  } finally {
    session.startCleanup();
    try {
      if (started) {
        await verifyEnvironmentOwnership(manifest, inspect, true);
        const stopped = await session.execute(
          [...compose, 'stop', '--timeout', '20', ...services],
          { timeout: 30_000 },
        );
        if (code === 0 && stopped.code !== 0) code = stopped.code;
        if (code === 0 && !session.interrupted) {
          const ids = await inspect([
            ...compose,
            'ps',
            '--all',
            '--quiet',
            ...services,
          ]);
          if (ids) {
            const exits = await inspect([
              'docker',
              'inspect',
              '--format',
              '{{.State.ExitCode}}',
              ...ids.split(/\s+/),
            ]);
            code =
              exits
                .split(/\s+/)
                .map(Number)
                .find((exit) => exit !== 0) ?? 0;
          }
        }
      }
    } finally {
      if (session.interrupted) code = session.interrupted;
      session.close();
    }
  }
  return code;
}

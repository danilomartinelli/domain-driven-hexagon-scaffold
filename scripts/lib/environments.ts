import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { applications } from '../../database/applications';
import {
  environmentLocation,
  environmentVariables,
  readEnvironment,
  workspaceRoot,
  type EnvironmentKind,
  type EnvironmentManifest,
} from '../../database/environment';
import { composeConfiguration } from './compose';
import { commandSession } from './session';

async function availablePort(): Promise<number> {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('No loopback port'));
        return;
      }
      server.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
}

async function newManifest(
  environment: EnvironmentKind,
  run: string,
): Promise<EnvironmentManifest> {
  const { project } = environmentLocation(environment, run);
  const ports = new Set<number>();
  async function nextPort(variable: string) {
    const override = process.env[variable];
    let port =
      override === undefined ? await availablePort() : Number(override);
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error(`Invalid port: ${variable}`);
    if (override !== undefined && ports.has(port))
      throw new Error(`Duplicate port: ${variable}`);
    while (ports.has(port)) port = await availablePort();
    ports.add(port);
    return port;
  }
  const databases: EnvironmentManifest['databases'] = [];
  for (const app of applications)
    databases.push({
      app: app.name,
      prefix: app.prefix,
      host: '127.0.0.1',
      port: await nextPort(`${app.prefix}_PORT`),
      username: 'starter',
      password: randomUUID(),
      database: `${project.replaceAll('-', '_')}_${app.name}`,
    });
  return {
    environment,
    run,
    project,
    owner: randomUUID(),
    status: 'starting',
    databases,
    broker: {
      port: await nextPort('RABBITMQ_PORT'),
      managementPort: await nextPort('RABBITMQ_MANAGEMENT_PORT'),
      username: 'starter',
      password: randomUUID(),
      vhost: project,
    },
    gateway: {
      name: `${project}-gateway`,
      host: process.env.GATEWAY_HOST ?? 'host.docker.internal',
      proxyPort: await nextPort('GATEWAY_PROXY_PORT'),
      adminPort: await nextPort('GATEWAY_ADMIN_PORT'),
      userPort: await nextPort('USER_HTTP_PORT'),
      walletPort: await nextPort('WALLET_HTTP_PORT'),
    },
  };
}

export async function operateEnvironment(
  action: 'prepare' | 'down' | 'exec' | 'run',
  environment: EnvironmentKind,
  run: string,
  command: string[] = [],
): Promise<number> {
  const location = environmentLocation(environment, run);
  const creating = action === 'prepare' || action === 'run';
  if ((action === 'exec' || action === 'run') && !command.length)
    throw new Error('A command after -- is required.');
  if (action === 'down' && !existsSync(location.manifestPath)) return 0;
  let manifest: EnvironmentManifest;
  if (creating && !existsSync(location.manifestPath)) {
    manifest = await newManifest(environment, run);
    mkdirSync(location.directory, { recursive: true });
    // Exclusive creation prevents a concurrent prepare from taking over the run.
    writeFileSync(location.manifestPath, JSON.stringify(manifest, null, 2), {
      flag: 'wx',
      mode: 0o600,
    });
  } else {
    manifest = readEnvironment(environment, run);
    if (creating && environment === 'test')
      throw new Error('Test run already exists. Select a new run ID.');
  }
  const composePath = join(location.directory, 'compose.json');
  const save = () => {
    writeFileSync(location.manifestPath, JSON.stringify(manifest, null, 2), {
      mode: 0o600,
    });
  };
  // Use only known fields; inherited Compose options/.env cannot change ownership.
  const composeEnv = {
    ...process.env,
    COMPOSE_DISABLE_ENV_FILE: '1',
    COMPOSE_PROFILES: '',
    COMPOSE_REMOVE_ORPHANS: '0',
  };
  const session = commandSession(
    workspaceRoot,
    join(location.directory, 'run.log'),
    composeEnv,
  );
  const compose = [
    'docker',
    'compose',
    '--project-name',
    manifest.project,
    '--file',
    composePath,
  ];
  let code = 1;
  let commandExitCode: number | undefined;
  let cleanupExitCode = 0;
  const ownership = { verified: false };
  const requireSuccess = async (args: string[]) => {
    const result = await session.execute(args, {
      capture: true,
      timeout: 15_000,
    });
    if (result.code !== 0)
      throw new Error(`Resource inspection failed (${String(result.code)}).`);
    return result.stdout.trim();
  };
  async function verifyOwnership(allowExisting: boolean) {
    for (const resource of ['container', 'network', 'volume'] as const) {
      const ids = await requireSuccess(
        resource === 'container'
          ? [
              'docker',
              'ps',
              '-aq',
              '--filter',
              `label=com.docker.compose.project=${manifest.project}`,
            ]
          : [
              'docker',
              resource,
              'ls',
              '-q',
              '--filter',
              `label=com.docker.compose.project=${manifest.project}`,
            ],
      );
      if (!ids) continue;
      if (!allowExisting)
        throw new Error('Refusing to adopt existing resources for a new run.');
      const ownership = await requireSuccess([
        'docker',
        resource,
        'inspect',
        '--format',
        resource === 'container'
          ? '{{index .Config.Labels "dev.starter.owner"}}'
          : '{{index .Labels "dev.starter.owner"}}',
        ...ids.split(/\s+/),
      ]);
      if (ownership.split(/\s+/).some((owner) => owner !== manifest.owner))
        throw new Error('Refusing resource owned by another environment.');
    }
  }
  async function shutdown() {
    session.startCleanup();
    await verifyOwnership(true);
    await session.execute([...compose, 'logs', '--no-color'], {
      timeout: 15_000,
    });
    const result = await session.execute(
      [...compose, 'down', '--timeout', '10'],
      { timeout: 30_000 },
    );
    if (result.code === 0) {
      manifest.status = 'stopped';
      save();
    }
    return result.code;
  }
  session.log(`Test run: ${manifest.project}`);
  session.log(`Environment: ${location.manifestPath}`);
  async function workflow(): Promise<number> {
    await verifyOwnership(!creating || manifest.environment === 'development');
    ownership.verified = true;
    writeFileSync(
      composePath,
      JSON.stringify(composeConfiguration(manifest), null, 2),
      { mode: 0o600 },
    );
    if (creating) {
      const up = await session.execute(
        [...compose, 'up', '--detach', '--wait', '--wait-timeout', '60'],
        { timeout: 90_000 },
      );
      if (up.code !== 0) {
        code = up.code;
        return code;
      }
      manifest.status = 'ready';
      save();
    }
    if (action === 'down') {
      code = await shutdown();
      cleanupExitCode = code;
      return code;
    }
    if (manifest.status !== 'ready')
      throw new Error('Environment is not ready.');
    const env = environmentVariables(manifest);
    if (action === 'run') {
      for (const app of applications) {
        for (const script of ['migration:up:tests', 'seed:up:tests']) {
          const result = await session.execute(
            [process.execPath, '--no-env-file', 'run', script],
            { env: { ...env, DATABASE_APP: app.name } },
          );
          if (result.code !== 0) {
            code = result.code;
            return code;
          }
        }
      }
    }
    if (command.length) {
      const result = await session.execute(command, { env, timeout: 300_000 });
      commandExitCode = result.code;
      code = result.code;
    } else code = 0;
    return code;
  }
  try {
    code = await workflow();
  } catch (error) {
    session.log(error instanceof Error ? error.message : String(error));
    code = 1;
  } finally {
    if (
      ownership.verified &&
      (action === 'run' ||
        (creating && (code !== 0 || session.interrupted !== 0)))
    ) {
      try {
        cleanupExitCode = await shutdown();
      } catch (error) {
        session.log(String(error));
        cleanupExitCode = 1;
      }
    }
    if (session.interrupted) code = session.interrupted;
    else if (code === 0 && cleanupExitCode !== 0) code = cleanupExitCode;
    writeFileSync(
      join(location.directory, 'result.json'),
      JSON.stringify(
        {
          project: manifest.project,
          commandExitCode,
          cleanupExitCode,
          exitCode: code,
        },
        null,
        2,
      ),
    );
    session.close();
  }
  return code;
}

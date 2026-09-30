import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { join, relative } from 'node:path';
import {
  applications,
  selectApplication,
  type DatabaseApplication,
} from '../../database/applications';
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
import { bunTestCounts, describeCounts } from './test-counts';

export async function availablePort(): Promise<number> {
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

type PortAllocator = (variable: string) => Promise<number>;

/** An explicit shell port wins; allocated ports never repeat one already taken. */
function portAllocator(taken: number[] = []): PortAllocator {
  const ports = new Set(taken);
  return async (variable) => {
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
  };
}

async function scopedDatabase(
  app: DatabaseApplication,
  project: string,
  nextPort: PortAllocator,
): Promise<EnvironmentManifest['databases'][number]> {
  return {
    app: app.name,
    prefix: app.prefix,
    host: '127.0.0.1',
    port: await nextPort(`${app.prefix}_PORT`),
    username: 'starter',
    password: randomUUID(),
    database: `${project.replaceAll('-', '_')}_${app.name}`,
    ...(app.runtimeRole && {
      runtime: { username: app.runtimeRole, password: randomUUID() },
    }),
  };
}

/**
 * A development run keeps its existing databases, credentials and volumes;
 * applications registered after it was created get new databases.
 */
async function addRegisteredDatabases(
  manifest: EnvironmentManifest,
): Promise<boolean> {
  // Every numeric coordinate in these sections is an allocated port.
  const nextPort = portAllocator(
    [manifest.broker, manifest.gateway, ...manifest.databases].flatMap(
      (section) =>
        Object.values(section).filter((value) => typeof value === 'number'),
    ),
  );
  const missing = applications.filter(
    (app) => !manifest.databases.some((db) => db.app === app.name),
  );
  for (const app of missing)
    manifest.databases.push(
      await scopedDatabase(app, manifest.project, nextPort),
    );
  return missing.length > 0;
}

async function newManifest(
  environment: EnvironmentKind,
  run: string,
): Promise<EnvironmentManifest> {
  const { project } = environmentLocation(environment, run);
  const nextPort = portAllocator();
  const databases: EnvironmentManifest['databases'] = [];
  for (const app of applications)
    databases.push(await scopedDatabase(app, project, nextPort));
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

/**
 * `apps` selects the applications a `run` migrates and seeds (default: all).
 * Every registered database is still provisioned, so isolation checks can
 * reach the other applications' targets.
 */
export async function operateEnvironment(
  action: 'prepare' | 'down' | 'exec' | 'run',
  environment: EnvironmentKind,
  run: string,
  command: string[] = [],
  apps: string[] = applications.map((app) => app.name),
): Promise<number> {
  const location = environmentLocation(environment, run);
  const creating = action === 'prepare' || action === 'run';
  if ((action === 'exec' || action === 'run') && !command.length)
    throw new Error('A command after -- is required.');
  const selected = apps.map((name) => selectApplication(name));
  if (action === 'down' && !existsSync(location.manifestPath)) return 0;
  let manifest: EnvironmentManifest;
  const save = () => {
    writeFileSync(location.manifestPath, JSON.stringify(manifest, null, 2), {
      mode: 0o600,
    });
  };
  if (creating && !existsSync(location.manifestPath)) {
    manifest = await newManifest(environment, run);
    mkdirSync(location.directory, { recursive: true });
    // Exclusive creation prevents a concurrent prepare from taking over the run.
    writeFileSync(location.manifestPath, JSON.stringify(manifest, null, 2), {
      flag: 'wx',
      mode: 0o600,
    });
  } else {
    const extending = creating && environment === 'development';
    manifest = readEnvironment(environment, run, {
      complete: !extending && action !== 'down',
    });
    if (creating && environment === 'test')
      throw new Error('Test run already exists. Select a new run ID.');
    if (extending && (await addRegisteredDatabases(manifest))) save();
  }
  const composePath = join(location.directory, 'compose.json');
  // Use only known fields; inherited Compose options/.env cannot change ownership.
  const composeEnv = {
    ...process.env,
    COMPOSE_DISABLE_ENV_FILE: '1',
    COMPOSE_PROFILES: '',
    COMPOSE_REMOVE_ORPHANS: '0',
  };
  const logPath = join(location.directory, 'run.log');
  const session = commandSession(workspaceRoot, logPath, composeEnv);
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
  let tests: ReturnType<typeof bunTestCounts>;
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
  /** Container logs always reach run.log; the terminal gets them on failure. */
  async function shutdown(showLogs: boolean) {
    session.startCleanup();
    await verifyOwnership(true);
    await session.execute([...compose, 'logs', '--no-color'], {
      timeout: 15_000,
      echo: showLogs,
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
      code = await shutdown(false);
      cleanupExitCode = code;
      return code;
    }
    if (manifest.status !== 'ready')
      throw new Error('Environment is not ready.');
    const env = environmentVariables(manifest);
    if (action === 'run') {
      for (const app of selected) {
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
      const offset = statSync(logPath).size;
      const result = await session.execute(command, {
        env,
        timeout:
          action === 'exec' && environment === 'development' ? null : 300_000,
      });
      commandExitCode = result.code;
      tests = bunTestCounts(readFileSync(logPath).subarray(offset).toString());
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
        cleanupExitCode = await shutdown(
          code !== 0 || session.interrupted !== 0,
        );
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
          ...(tests && { tests }),
          cleanupExitCode,
          exitCode: code,
        },
        null,
        2,
      ),
    );
    // The final line summarises the run, however much output precedes it.
    session.log(
      `Result: exit ${String(code)} (command ${String(commandExitCode ?? '-')}, cleanup ${String(cleanupExitCode)}); ` +
        describeCounts(tests) +
        `log ${relative(workspaceRoot, logPath)}`,
    );
    session.close();
  }
  return code;
}

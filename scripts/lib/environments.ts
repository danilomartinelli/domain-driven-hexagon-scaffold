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
import { environmentPrefix } from '@starter/capabilities/declaration';
import {
  selectedApplications,
  validateApplications,
} from '../../database/topology';
import {
  activeDatabases,
  needsGateway,
  needsMessaging,
} from '../../database/environment';
import { composeConfiguration } from './compose';
import { removeDevelopmentImages } from './development-images';
import { failureExcerpt } from './failure-excerpt';
import { commandSession } from './session';
import { verifyEnvironmentOwnership } from './ownership';
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

/** Allocate only missing resources; retained identities and ports never rotate. */
async function reconcileManifest(
  manifest: EnvironmentManifest,
  selection?: string[],
  retainMissing = false,
): Promise<void> {
  const topology = selectedApplications(selection, { retainMissing });
  validateApplications(topology);
  const nextPort = portAllocator([
    ...Object.values(manifest.applicationPorts),
    ...[manifest.broker, manifest.gateway, ...manifest.databases].flatMap(
      (section) =>
        Object.values(section ?? {}).filter(
          (value) => typeof value === 'number',
        ),
    ),
  ]);
  // Upgrade the old gateway-owned coordinates without reallocating listeners.
  for (const [name, port] of Object.entries(manifest.gateway ?? {})) {
    if (
      name !== 'proxyPort' &&
      name !== 'adminPort' &&
      name.endsWith('Port') &&
      typeof port === 'number' &&
      !Object.hasOwn(manifest.applicationPorts, name.slice(0, -4))
    )
      manifest.applicationPorts[name.slice(0, -4)] = port;
  }
  manifest.apps = selection;
  manifest.topology = topology;
  for (const app of topology) {
    if (!Object.hasOwn(manifest.applicationPorts, app.name))
      manifest.applicationPorts[app.name] = await nextPort(
        `${environmentPrefix(app.name)}_HTTP_PORT`,
      );
    const existing = manifest.databases.find((db) => db.app === app.name);
    if (
      app.persistence &&
      existing &&
      existing.prefix !== selectApplication(app.name).prefix
    )
      throw new Error(
        `Retained database identity conflicts with application: ${app.name}`,
      );
    if (app.persistence && !existing)
      manifest.databases.push(
        await scopedDatabase(
          selectApplication(app.name),
          manifest.project,
          nextPort,
        ),
      );
  }
  if (needsMessaging(manifest) && !manifest.broker)
    manifest.broker = {
      port: await nextPort('RABBITMQ_PORT'),
      managementPort: await nextPort('RABBITMQ_MANAGEMENT_PORT'),
      username: 'starter',
      password: randomUUID(),
      vhost: manifest.project,
    };
  if (needsGateway(manifest) && !manifest.gateway)
    manifest.gateway = {
      name: `${manifest.project}-gateway`,
      host: process.env.GATEWAY_HOST ?? 'host.docker.internal',
      proxyPort: await nextPort('GATEWAY_PROXY_PORT'),
      adminPort: await nextPort('GATEWAY_ADMIN_PORT'),
    };
}

async function newManifest(
  environment: EnvironmentKind,
  run: string,
  selection?: string[],
): Promise<EnvironmentManifest> {
  const { project } = environmentLocation(environment, run);
  const manifest: EnvironmentManifest = {
    environment,
    run,
    project,
    owner: randomUUID(),
    status: 'starting',
    databases: [],
    applicationPorts: {},
  };
  await reconcileManifest(manifest, selection);
  return manifest;
}

/** `dev` starts the selected applications after their databases are migrated. */
const developmentCommand = [
  process.execPath,
  '--no-env-file',
  'run',
  'start:dev',
];

/**
 * Selected declarations determine the service union, migrations and startup.
 * Development keeps the complete resource inventory after declarations disappear.
 * Once ready, development infrastructure outlives migrations and applications.
 */
export async function operateEnvironment(
  action: 'prepare' | 'down' | 'exec' | 'run' | 'dev' | 'inspect',
  environment: EnvironmentKind,
  run: string,
  command: string[] = [],
  apps?: string[],
  setupDatabase = true,
): Promise<number> {
  const location = environmentLocation(environment, run);
  const creating = action === 'prepare' || action === 'run' || action === 'dev';
  if (apps && !creating)
    throw new Error('Select applications during preparation.');
  if ((action === 'exec' || action === 'run') && !command.length)
    throw new Error('A command after -- is required.');
  if (action === 'dev' && (environment !== 'development' || command.length))
    throw new Error('Usage: dev [--run=<id>] (development only, no command)');
  const commandToRun = action === 'dev' ? developmentCommand : command;
  if (action === 'down' && !existsSync(location.manifestPath)) return 0;
  let manifest: EnvironmentManifest;
  let previousTopology: EnvironmentManifest['topology'];
  const save = () => {
    writeFileSync(location.manifestPath, JSON.stringify(manifest, null, 2), {
      mode: 0o600,
    });
  };
  if (creating && !existsSync(location.manifestPath)) {
    manifest = await newManifest(environment, run, apps);
    mkdirSync(location.directory, { recursive: true });
    // Exclusive creation prevents a concurrent prepare from taking over the run.
    writeFileSync(location.manifestPath, JSON.stringify(manifest, null, 2), {
      flag: 'wx',
      mode: 0o600,
    });
  } else {
    const extending = creating && environment === 'development';
    manifest = readEnvironment(environment, run, {
      complete: !extending && action !== 'down' && action !== 'inspect',
    });
    previousTopology = manifest.topology;
    if (creating && environment === 'test')
      throw new Error('Test run already exists. Select a new run ID.');
    if (extending)
      await reconcileManifest(manifest, apps ?? manifest.apps, !apps);
  }
  if (action === 'exec') validateApplications(manifest.topology ?? []);
  const composePath = join(location.directory, 'compose.json');
  // Use only known fields; inherited Compose options/.env cannot change ownership.
  const composeEnv = {
    ...process.env,
    COMPOSE_DISABLE_ENV_FILE: '1',
    COMPOSE_PROFILES: '',
    COMPOSE_REMOVE_ORPHANS: '0',
  };
  const logPath = join(location.directory, 'run.log');
  let failureOffset = existsSync(logPath) ? statSync(logPath).size : 0;
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
  let failure: string | undefined;
  let cleanupExitCode = 0;
  const ownership = { verified: false };
  const infrastructure = { ready: false };
  const requireSuccess = async (args: string[]) => {
    const result = await session.execute(args, {
      capture: true,
      timeout: 15_000,
    });
    if (result.code !== 0)
      throw new Error(`Resource inspection failed (${String(result.code)}).`);
    return result.stdout.trim();
  };
  const verifyOwnership = (allowExisting: boolean) =>
    verifyEnvironmentOwnership(manifest, requireSuccess, allowExisting);
  /** Container logs always reach run.log; the terminal gets them on failure. */
  async function shutdown(showLogs: boolean) {
    session.startCleanup();
    await verifyOwnership(true);
    if (
      !manifest.databases.length &&
      !manifest.broker &&
      !manifest.gateway &&
      manifest.environment !== 'development'
    ) {
      manifest.status = 'stopped';
      save();
      return 0;
    }
    await session.execute([...compose, 'logs', '--no-color'], {
      timeout: 15_000,
      echo: showLogs,
    });
    const result = await session.execute(
      [
        ...compose,
        '--profile',
        'applications',
        'down',
        '--remove-orphans',
        '--timeout',
        '20',
      ],
      { timeout: 30_000 },
    );
    if (result.code === 0) {
      try {
        await removeDevelopmentImages(manifest, requireSuccess);
      } catch (error) {
        session.log(String(error));
        return 1;
      }
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
    if (action === 'inspect') {
      const active = new Set(activeDatabases(manifest).map((db) => db.app));
      session.log(
        JSON.stringify({
          project: manifest.project,
          owner: manifest.owner,
          status: manifest.status,
          applications: manifest.topology ?? [],
          applicationPorts: manifest.applicationPorts,
          databases: manifest.databases.map((db) => ({
            app: db.app,
            service: `postgres-${db.app}`,
            database: db.database,
            port: db.port,
            ...(manifest.environment === 'development'
              ? { volume: `${manifest.project}_${db.app}-postgres` }
              : { storage: 'tmpfs' }),
            active: active.has(db.app),
          })),
          broker: manifest.broker
            ? {
                vhost: manifest.broker.vhost,
                port: manifest.broker.port,
                ...(manifest.environment === 'development'
                  ? { volume: `${manifest.project}_rabbitmq` }
                  : { storage: 'tmpfs' }),
                active: needsMessaging(manifest),
              }
            : undefined,
          gateway: manifest.gateway
            ? { name: manifest.gateway.name, active: needsGateway(manifest) }
            : undefined,
        }),
      );
      return 0;
    }
    writeFileSync(
      composePath,
      JSON.stringify(
        composeConfiguration(manifest, { shutdown: action === 'down' }),
        null,
        2,
      ),
      { mode: 0o600 },
    );
    if (creating) {
      if (manifest.environment === 'development') {
        const changed = (previousTopology ?? []).filter(
          (app) =>
            JSON.stringify(app) !==
            JSON.stringify(
              manifest.topology?.find((entry) => entry.name === app.name),
            ),
        );
        for (const app of changed) {
          const ids = await requireSuccess([
            'docker',
            'ps',
            '-q',
            '--filter',
            `label=com.docker.compose.project=${manifest.project}`,
            '--filter',
            `label=com.docker.compose.service=app-${app.name}`,
          ]);
          if (ids) {
            const stopped = await session.execute(
              ['docker', 'stop', '--time=20', ...ids.split(/\s+/)],
              { timeout: 30_000 },
            );
            if (stopped.code !== 0) return (code = stopped.code);
          }
        }
      }
      manifest.status = 'starting';
      save();
      const active = [
        ...activeDatabases(manifest).map((db) => `postgres-${db.app}`),
        ...(needsMessaging(manifest) ? ['rabbitmq'] : []),
        ...(needsGateway(manifest) ? ['gateway'] : []),
      ];
      const inactive = [
        ...manifest.databases.map((db) => `postgres-${db.app}`),
        ...(manifest.broker ? ['rabbitmq'] : []),
        ...(manifest.gateway ? ['gateway'] : []),
      ].filter((service) => !active.includes(service));
      if (inactive.length) {
        const stopped = await session.execute(
          [...compose, 'stop', '--timeout', '10', ...inactive],
          { timeout: 30_000 },
        );
        if (stopped.code !== 0) return (code = stopped.code);
      }
      // Kong reads its DB-less configuration at startup. Compose's inline config
      // content may change without recreating the container; explicitly recreate
      // this stateless service so removed routes disappear as well as new ones join.
      const batches = [
        active.filter((service) => service !== 'gateway'),
        active.filter((service) => service === 'gateway'),
      ];
      for (const services of batches) {
        if (!services.length) continue;
        const up = await session.execute(
          [
            ...compose,
            'up',
            '--detach',
            '--wait',
            '--wait-timeout',
            '60',
            ...(services.includes('gateway') ? ['--force-recreate'] : []),
            ...services,
          ],
          { timeout: 90_000 },
        );
        if (up.code !== 0) return (code = up.code);
      }
      if (activeDatabases(manifest).length) {
        const reconciled = await session.execute([
          process.execPath,
          '--no-env-file',
          'scripts/reconcile-databases.ts',
          location.manifestPath,
        ]);
        if (reconciled.code !== 0) return (code = reconciled.code);
      }
      manifest.status = 'ready';
      save();
      infrastructure.ready = true;
    }
    if (action === 'down') {
      code = await shutdown(false);
      cleanupExitCode = code;
      return code;
    }
    if (manifest.status !== 'ready')
      throw new Error('Environment is not ready.');
    const env = environmentVariables(manifest);
    const setup =
      action === 'dev'
        ? ['migration:up']
        : action === 'run' && setupDatabase
          ? ['migration:up:tests', 'seed:up:tests']
          : [];
    for (const app of activeDatabases(manifest).filter(
      (db) => db.prefix !== 'DB',
    )) {
      for (const script of setup) {
        const result = await session.execute(
          [process.execPath, '--no-env-file', 'run', script],
          { env: { ...env, DATABASE_APP: app.app } },
        );
        if (result.code !== 0) {
          code = result.code;
          return code;
        }
      }
    }
    if (commandToRun.length) {
      failureOffset = statSync(logPath).size;
      const result = await session.execute(commandToRun, {
        env,
        gracePeriod: environment === 'development' ? 25_000 : 5_000,
        timeout:
          action === 'dev' ||
          (action === 'exec' && environment === 'development')
            ? null
            : 300_000,
      });
      commandExitCode = result.code;
      tests = bunTestCounts(
        readFileSync(logPath).subarray(failureOffset).toString(),
      );
      code = result.code;
    } else code = 0;
    return code;
  }
  try {
    code = await workflow();
    if (code !== 0)
      failure = failureExcerpt(
        readFileSync(logPath).subarray(failureOffset).toString(),
      );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    session.log(message);
    failure = failureExcerpt(message);
    code = 1;
  } finally {
    if (
      ownership.verified &&
      (action === 'run' ||
        (creating &&
          !(action === 'dev' && infrastructure.ready) &&
          (code !== 0 || session.interrupted !== 0)))
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
    if (failure)
      session.log(
        `Failure excerpt (bounded; full output in run.log):\n${failure}`,
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

import { spyOn } from 'bun:test';
import * as processes from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { ApplicationDeclaration } from '@starter/capabilities/declaration';
import type {
  EnvironmentKind,
  EnvironmentManifest,
  RecordedManifest,
} from '../../database/environment';
import {
  retainResources,
  type InstallationState,
} from '../lib/operations-config';
import { createWorkspace } from './workspace-fixture';

export const capabilityCases: ApplicationDeclaration[] = [
  {
    name: 'order-history',
    persistence: false,
    messaging: false,
    exposure: false,
  },
  {
    name: 'order-history',
    persistence: false,
    messaging: false,
    exposure: true,
  },
  {
    name: 'order-history',
    persistence: false,
    messaging: true,
    exposure: false,
  },
  {
    name: 'order-history',
    persistence: false,
    messaging: true,
    exposure: true,
  },
  {
    name: 'order-history',
    persistence: true,
    messaging: false,
    exposure: false,
  },
  {
    name: 'order-history',
    persistence: true,
    messaging: false,
    exposure: true,
  },
  {
    name: 'order-history',
    persistence: true,
    messaging: true,
    exposure: false,
  },
  { name: 'order-history', persistence: true, messaging: true, exposure: true },
].map((app) => ({
  ...app,
  ...(app.exposure && {
    routes: [
      {
        name: 'history',
        paths: ['~/history$'],
        stripPath: true,
        upstreamPath: '/history',
      },
    ],
  }),
}));

export const selection: ApplicationDeclaration[] = [
  { name: 'order', persistence: true, messaging: true, exposure: false },
  {
    name: 'order-history',
    persistence: false,
    messaging: false,
    exposure: true,
    routes: [
      {
        name: 'history',
        paths: ['~/history$'],
        stripPath: true,
        upstreamPath: '/history',
      },
    ],
  },
];

/** Only the OS process boundary is replaced; renderer and runner modules stay real. */
export async function withProcesses<T>(
  respond: (command: string[]) => {
    code?: number;
    stdout?: string;
    stderr?: string;
  },
  action: () => Promise<T>,
): Promise<T> {
  const spawn = (
    command: string,
    args?: readonly string[] | processes.SpawnOptions,
  ): processes.ChildProcess => {
    const arguments_: readonly string[] = Array.isArray(args)
      ? (args as string[])
      : [];
    const result = respond([command, ...arguments_]);
    // A process double has no PID, so deadlines cannot signal a real process.
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    }) as unknown as processes.ChildProcess;
    queueMicrotask(() => {
      child.stdout?.emit('data', result.stdout ?? '');
      child.stderr?.emit('data', result.stderr ?? '');
      child.emit('close', result.code ?? 0);
    });
    return child;
  };
  const double = spyOn(processes, 'spawn').mockImplementation(
    spawn as typeof processes.spawn,
  );
  try {
    return await action();
  } finally {
    double.mockRestore();
  }
}

/** Ambient credentials and dotenv settings must never become characterization inputs. */
export async function withShell<T>(
  shell: NodeJS.ProcessEnv,
  action: () => Promise<T>,
): Promise<T> {
  const original = process.env;
  process.env = { ...shell };
  try {
    return await action();
  } finally {
    process.env = original;
  }
}

interface RendererFixture
  extends
    Pick<typeof import('../lib/compose'), 'composeConfiguration'>,
    Pick<
      typeof import('../lib/application-containers'),
      'applicationContainer'
    >,
    Pick<typeof import('../lib/platform-image-runtime'), 'dockerImageRuntime'>,
    Pick<typeof import('../../database/environment'), 'environmentVariables'>,
    Pick<typeof import('../lib/environments'), 'operateEnvironment'> {
  ownedInfrastructure: Pick<
    typeof import('../../database/owned-infrastructure'),
    'preparedInfrastructure'
  >;
  manifest: (
    kind: EnvironmentKind,
    apps: ApplicationDeclaration[],
    retained?: boolean,
  ) => Promise<EnvironmentManifest>;
  installation: (apps: ApplicationDeclaration[]) => InstallationState;
  normalize: (value: unknown, inventory: EnvironmentManifest) => unknown;
  cleanup: () => Promise<void>;
}

export async function rendererFixture(): Promise<RendererFixture> {
  const workspace = await createWorkspace();
  try {
    const declare = async (apps: ApplicationDeclaration[]) => {
      for (const app of apps) {
        const directory = join(workspace.root, 'src/apps', app.name);
        await mkdir(directory, { recursive: true });
        for (const [file, content] of Object.entries({
          'application.json': app,
          'composition.json': {
            integrations: ['persistence', 'messaging', 'exposure'],
            groups: [],
          },
          'distribution.json': {
            dependencies: ['@starter/core'],
            integrations: {
              persistence: {
                dependencies: ['@starter/nest-support'],
                paths: ['database'],
              },
              messaging: {
                dependencies: ['@starter/rabbitmq'],
                paths: ['messaging'],
              },
              exposure: {
                dependencies: ['@starter/integration-contracts'],
                paths: ['api'],
              },
            },
          },
        }))
          await writeFile(join(directory, file), JSON.stringify(content));
      }
    };
    await declare([
      { name: 'order', persistence: true, messaging: true, exposure: true },
      capabilityCases[7],
    ]);
    const environment = (await import(
      join(workspace.root, 'database/environment.ts')
    )) as typeof import('../../database/environment');
    const ownedInfrastructure = (await import(
      join(workspace.root, 'database/owned-infrastructure.ts')
    )) as typeof import('../../database/owned-infrastructure');
    const compose = (await import(
      join(workspace.root, 'scripts/lib/compose.ts')
    )) as typeof import('../lib/compose');
    const containers = (await import(
      join(workspace.root, 'scripts/lib/application-containers.ts')
    )) as typeof import('../lib/application-containers');
    const images = (await import(
      join(workspace.root, 'scripts/lib/platform-image-runtime.ts')
    )) as typeof import('../lib/platform-image-runtime');
    const environments = (await import(
      join(workspace.root, 'scripts/lib/environments.ts')
    )) as typeof import('../lib/environments');
    const manifest = async (
      kind: EnvironmentKind,
      apps: ApplicationDeclaration[],
      retained = false,
    ): Promise<EnvironmentManifest> => {
      await declare(apps);
      const location = environment.environmentLocation(kind, 'renderers');
      // Written as manifests were before services and volumes were recorded.
      const value: RecordedManifest = {
        environment: kind,
        run: 'renderers',
        project: location.project,
        owner: '00000000-0000-4000-8000-000000000093',
        status: 'ready',
        apps: apps.map((app) => app.name),
        topology: apps,
        applicationPorts: Object.fromEntries(
          apps.map((app, index) => [app.name, 3100 + index]),
        ),
        databases: apps
          .filter((app) => app.persistence || retained)
          .map((app, index) => ({
            app: app.name,
            prefix: `${app.name.replaceAll('-', '_').toUpperCase()}_DB`,
            host: '127.0.0.1',
            port: 15432 + index,
            username: 'fixture-owner',
            password: "owner'$fixture",
            database: `${location.project.replaceAll('-', '_')}_${app.name}`,
            runtime: {
              username: `${app.name.replaceAll('-', '_')}_runtime`,
              password: "runtime'$fixture",
            },
          })),
        ...(apps.some((app) => app.messaging) || retained
          ? {
              broker: {
                port: 15672,
                managementPort: 25672,
                username: 'fixture user',
                password: 'broker/$fixture',
                vhost: location.project,
              },
            }
          : {}),
        ...(apps.some((app) => app.exposure) || retained
          ? {
              gateway: {
                name: `${location.project}-gateway`,
                host: 'host.docker.internal',
                proxyPort: 18000,
                adminPort: 18001,
              },
            }
          : {}),
      };
      if (retained)
        value.databases.push({
          app: 'legacy',
          prefix: 'DB',
          host: '127.0.0.1',
          port: 15434,
          username: 'legacy-owner',
          password: 'legacy-fixture',
          database: `${location.project.replaceAll('-', '_')}_legacy`,
        });
      await mkdir(location.directory, { recursive: true });
      await writeFile(location.manifestPath, JSON.stringify(value));
      return environment.readEnvironment(kind, 'renderers', {
        complete: false,
      });
    };
    const installation = (
      apps: ApplicationDeclaration[],
    ): InstallationState => {
      const artifacts = (declarations: ApplicationDeclaration[]) =>
        declarations.map((declaration) => ({
          image: `example/${declaration.name}@sha256:${'a'.repeat(64)}`,
          declaration,
        }));
      const identity = {
        project: 'fixture-installation',
        retained: { databases: [] },
      };
      return {
        version: 2,
        name: 'renderers',
        owner: 'fixture-owner',
        directory: '/fixture/$installation',
        applied: {
          applications: artifacts(apps),
          https: { bind: '127.0.0.1', port: 8443 },
        },
        ...identity,
        // An existing inventory, whose identities outlive capability disablement.
        retained: retainResources(
          identity,
          artifacts([...apps, capabilityCases[7]]),
        ),
      };
    };
    const normalize = (
      value: unknown,
      inventory: EnvironmentManifest,
    ): unknown =>
      JSON.parse(
        JSON.stringify(value)
          .replaceAll(workspace.root, '<workspace>')
          .replaceAll(
            inventory.project.replaceAll('-', '_'),
            '<database-project>',
          )
          .replaceAll(inventory.project, '<project>'),
      );
    return {
      composeConfiguration: compose.composeConfiguration,
      applicationContainer: containers.applicationContainer,
      dockerImageRuntime: images.dockerImageRuntime,
      environmentVariables: environment.environmentVariables,
      operateEnvironment: environments.operateEnvironment,
      ownedInfrastructure,
      manifest,
      installation,
      normalize,
      cleanup: async () => {
        // These manifests only ever reached process doubles; no durable resources exist.
        await rm(join(workspace.root, '.context/test-runs'), {
          recursive: true,
          force: true,
        });
        await workspace.cleanup();
      },
    };
  } catch (error) {
    await workspace.cleanup();
    throw error;
  }
}

/** Settings observed on Docker invocations, independent of the runtime's derivation. */
export async function imageSettings(
  fixture: Pick<RendererFixture, 'dockerImageRuntime'>,
  options: Parameters<RendererFixture['dockerImageRuntime']>[0],
  overrides: {
    runtime?: Record<string, string>;
    migration?: Record<string, string>;
  } = {},
): Promise<Record<string, Record<string, string>>> {
  const settings: Record<string, Record<string, string>> = {};
  await withProcesses(
    (command) => {
      if (command[0] !== 'docker') throw new Error('Unexpected process');
      if (command[1] === 'container' && command[2] === 'inspect')
        return {
          code: 1,
          stderr: `Error response from daemon: No such container: ${command[3]}`,
        };
      if (command[1] !== 'run') throw new Error('Unexpected Docker operation');
      const env: Record<string, string> = {};
      command.forEach((argument, index) => {
        if (argument !== '--env') return;
        const variable = command[index + 1];
        const separator = variable.indexOf('=');
        env[variable.slice(0, separator)] = variable.slice(separator + 1);
      });
      settings[command.includes('migration:status') ? 'migration' : 'runtime'] =
        env;
      return {};
    },
    async () => {
      const runtime = fixture.dockerImageRuntime(options);
      try {
        await runtime.start(undefined, overrides.runtime);
        if ((await runtime.migrate('status', overrides.migration)).code !== 0)
          throw new Error('Fixture migration failed');
      } finally {
        await runtime.cleanup();
      }
    },
  );
  return settings;
}

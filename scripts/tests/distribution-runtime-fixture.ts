import { mock } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import {
  environmentLocation,
  environmentVariables,
  workspaceRoot,
  type EnvironmentManifest,
} from '../../database/environment';
import { selectedApplications } from '../../database/topology';
import { runCommand, type CommandResult } from '../lib/command';

interface RuntimeProbe {
  mode: 'selection' | 'shutdown';
  app: 'user' | 'wallet';
  platform?: string;
  expectedExit?: number | number[];
}

/** Keep command mocks in a child; exercise the real distribution and Docker adapters. */
export function runDistributionRuntimeProbe(
  probe: RuntimeProbe,
): Promise<CommandResult> {
  return runCommand(
    [
      process.execPath,
      '--no-env-file',
      '-e',
      `import { exerciseDistributionRuntime } from ${JSON.stringify(import.meta.path)};
await exerciseDistributionRuntime(${JSON.stringify(probe)});`,
    ],
    { cwd: workspaceRoot },
  );
}

export async function exerciseDistributionRuntime(
  probe: RuntimeProbe,
): Promise<void> {
  const run = `runtime-${randomUUID().slice(0, 8)}`;
  const location = environmentLocation('test', run);
  const { app } = probe;
  const manifest: EnvironmentManifest = {
    environment: 'test',
    run,
    project: location.project,
    owner: randomUUID(),
    status: 'ready',
    apps: [app],
    topology: selectedApplications([app]),
    applicationPorts: { [app]: 1 },
    databases: [
      {
        app,
        prefix: `${app.toUpperCase()}_DB`,
        host: '127.0.0.1',
        port: 1,
        username: 'fixture',
        password: 'fixture',
        database: `${location.project.replaceAll('-', '_')}_${app}`,
        runtime: { username: `${app}_runtime`, password: 'fixture' },
      },
    ],
  };
  const image = `sha256:${'a'.repeat(64)}`;
  const calls: string[][] = [];
  let running = false;
  let removed = false;
  await mock.module(
    new URL('../lib/command.ts', import.meta.url).pathname,
    () => ({
      runCommand: (args: string[]) => {
        calls.push(args);
        let stdout = '';
        let stderr = '';
        let code = 0;
        if (args.includes('scripts/distribute.ts'))
          throw new Error('Host package selected instead of supplied image');
        if (args[0] !== 'docker') throw new Error('Unexpected command');
        switch (args[1]) {
          case 'ps':
            stdout = `gateway\npostgres-${app}\nrabbitmq\n`;
            break;
          case 'run':
            if (probe.mode === 'selection')
              throw new Error(
                `Selected image ${String(args.at(-3))} on ${args[args.indexOf('--platform') + 1]}`,
              );
            if (args.includes('--detach')) running = true;
            else
              stdout = JSON.stringify({
                platform: 'linux',
                arch: process.arch,
              });
            break;
          case 'info':
            stdout = process.arch;
            break;
          case 'exec':
            stdout = JSON.stringify({ status: 200, body: {} });
            break;
          case 'port':
            break;
          case 'stop':
            running = false;
            break;
          case 'inspect':
            stdout = '7';
            break;
          case 'logs':
            if (running || removed)
              throw new Error('Logs read outside stopped-container lifetime');
            stdout = 'shutdown drain started\n';
            stderr = 'shutdown deadline exceeded\n';
            break;
          case 'container':
            if (args.at(-1)?.includes('-command-')) {
              code = 1;
              stderr = `Error response from daemon: No such container: ${String(args.at(-1))}`;
            } else {
              stdout = JSON.stringify([
                {
                  Id: 'b'.repeat(64),
                  Config: { Labels: { 'dev.starter.owner': manifest.owner } },
                },
              ]);
            }
            break;
          case 'rm':
            removed = true;
            break;
          default:
            throw new Error(`Unexpected Docker command: ${args[1]}`);
        }
        return Promise.resolve({ code, stdout, stderr, timedOut: false });
      },
    }),
  );
  await mkdir(location.directory, { recursive: true });
  try {
    await writeFile(location.manifestPath, JSON.stringify(manifest), {
      mode: 0o600,
    });
    const env = environmentVariables(manifest, {
      PATH: process.env.PATH,
      DDH_VALIDATED_IMAGE: image,
      ...(probe.platform === undefined
        ? {}
        : { DDH_IMAGE_PLATFORM: probe.platform }),
    });
    for (const key of Object.keys(process.env))
      Reflect.deleteProperty(process.env, key);
    Object.assign(process.env, env);
    let error = '';
    try {
      if (probe.mode === 'selection') {
        const { withDistribution } = await import('./distribution-fixture');
        await withDistribution(app, () => Promise.resolve());
      } else {
        const { imageRuntime } = await import('./image-runtime');
        const runtime = await imageRuntime(
          app,
          manifest,
          {},
          {},
          workspaceRoot,
        );
        try {
          await runtime.start();
          await runtime.stop(probe.expectedExit);
        } finally {
          await runtime.cleanup();
        }
      }
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
    console.log(JSON.stringify({ error, calls, removed }));
  } finally {
    await rm(location.directory, { recursive: true, force: true });
  }
}

import { z } from 'zod';
import { backupApplication } from './operations-backup';
import type { Artifact, InstallationState } from './operations-config';
import type { InstallationRuntime } from './installation-runtime';
import {
  applicationRuntime,
  type ApplicationRuntime,
} from './operations-verification';
import {
  provisionApplication,
  verifyBrokerAccess,
  refreshOperationsGateway,
  type OperationsCommand,
  type OneShot,
} from './operations-services';

/** Probe the selected container even when its process or HTTP server is unavailable. */
export async function probeApplication(
  selected: Artifact,
  compose: OperationsCommand,
  execute: OperationsCommand,
  cleanup = false,
): Promise<ApplicationRuntime> {
  const container = await compose(
    ['ps', '--all', '-q', `app-${selected.declaration.name}`],
    10_000,
    cleanup,
  );
  const empty = { container, image: '', process: 'missing' };
  if (!container) return applicationRuntime(selected, empty);
  const inspected = z
    .object({ image: z.string(), process: z.string() })
    .parse(
      JSON.parse(
        await execute(
          [
            'docker',
            'inspect',
            '--format',
            '{"image":{{json .Config.Image}},"process":{{json .State.Status}}}',
            container,
          ],
          10_000,
          cleanup,
        ),
      ),
    );
  const observation = { container, ...inspected };
  if (inspected.process !== 'running' || inspected.image !== selected.image)
    return applicationRuntime(selected, observation);
  try {
    const health: unknown = JSON.parse(
      await compose(
        [
          'exec',
          '-T',
          `app-${selected.declaration.name}`,
          'bun',
          '-e',
          `
        const get = async path => {
          try {
            const response = await fetch('http://127.0.0.1:3000/health/' + path, { signal: AbortSignal.timeout(2000) });
            return { ok: response.ok, body: await response.json() };
          } catch { return null; }
        };
        const [http, ready, backlog] = await Promise.all([get('ready/http'), get('ready'), get('backlog')]);
        console.log(JSON.stringify({http: http?.ok ?? false, readiness: ready?.body ?? null, backlog: backlog?.body ?? null}));
      `,
        ],
        5_000,
        cleanup,
      ),
    );
    return applicationRuntime(selected, { ...observation, health });
  } catch {
    return applicationRuntime(selected, observation);
  }
}

/** Docker effects and observations for one owned installation. Commands retain the operator's lifecycle and fencing. */
export function dockerInstallationRuntime({
  current,
  compose,
  execute,
  oneShot,
}: {
  current: InstallationState;
  compose: OperationsCommand;
  execute: OperationsCommand;
  oneShot: OneShot;
}): InstallationRuntime {
  return {
    startDatabase: async (application) => {
      await compose([
        'up',
        '-d',
        '--wait',
        '--wait-timeout',
        '60',
        `postgres-${application}`,
      ]);
    },
    provisionDatabase: async (application) => {
      await provisionApplication(compose, application);
    },
    startBroker: async () => {
      await compose(['up', '-d', '--wait', '--wait-timeout', '60', 'rabbitmq']);
    },
    verifyBroker: async (target) => {
      await verifyBrokerAccess(oneShot, target);
    },
    inspectMigrations: async (target) => {
      const evidence = await oneShot(`migrate-${target.declaration.name}`, [
        'run',
        'migration:status',
      ]);
      return {
        evidence,
        unknown: [...evidence.matchAll(/^missing file\t(.+)$/gm)].map(
          ([, migration]) => migration,
        ),
      };
    },
    migrate: async (target) => {
      await oneShot(`migrate-${target.declaration.name}`, [
        'run',
        'migration:up',
      ]);
    },
    stopApplication: async (application) => {
      await compose(['stop', '--timeout', '20', `app-${application}`]);
    },
    backup: (target, path) => backupApplication(current, target, path, compose),
    startCandidate: async (target) => {
      await compose([
        'up',
        '-d',
        '--no-deps',
        `app-${target.declaration.name}`,
      ]);
    },
    refreshGateway: () => refreshOperationsGateway(current, compose),
    observeCandidate: (target, cleanup) =>
      probeApplication(target, compose, execute, cleanup),
    collectCandidateDiagnostics: async (application) => {
      await compose(
        ['logs', '--no-color', '--tail', '200', `app-${application}`],
        15_000,
        true,
      );
    },
    // The application owns its 15-second shutdown; Compose grants 20 seconds.
    stopFailedCandidate: async (application) => {
      await compose(
        ['stop', '--timeout', '20', `app-${application}`],
        30_000,
        true,
      );
    },
  };
}

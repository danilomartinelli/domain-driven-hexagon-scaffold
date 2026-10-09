import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ReadinessSnapshot } from '@starter/capabilities/readiness';
import { randomUUID } from 'node:crypto';
import { operationsPromotion } from '../lib/operations-promotion';
import {
  readJson,
  writeJson,
  retainResources,
  stateSchema,
  type Artifact,
  type InstallationState,
} from '../lib/operations-config';
import { transitionSchema } from '../lib/operations-transition';
import {
  applicationRuntime,
  type VerificationClock,
} from '../lib/operations-verification';
import type { InstallationRuntime } from '../lib/installation-runtime';

export const artifact = (
  name = 'user',
  image = 'b',
  persistence = true,
  messaging = false,
): Artifact => ({
  image: `example/${name}@sha256:${image.repeat(64)}`,
  declaration: { name, persistence, messaging, exposure: false },
});
export function health(
  target: Artifact,
  ready = true,
): { http: boolean; readiness: ReadinessSnapshot; backlog: null } {
  const role: ReadinessSnapshot['publisher'] = {
    status: ready ? 'ready' : 'not_ready',
    connected: ready,
    failures: 0,
    retries: 0,
    retryDelayMs: 0,
    lastFailureAt: null,
    reason: ready ? null : 'messaging_unavailable',
  };
  return {
    http: true,
    readiness: {
      service: target.declaration.name,
      lifecycle: 'running',
      http: { status: 'ready' },
      database: {
        status: target.declaration.persistence ? 'ready' : 'not_applicable',
      },
      consumer: { status: 'not_applicable' },
      publisher: target.declaration.messaging
        ? role
        : { status: 'not_applicable' },
    },
    backlog: null,
  };
}
export class ManualVerificationClock implements VerificationClock {
  elapsed = 0;
  sleeps: number[] = [];
  onSleep?: () => void;
  now = (): number => this.elapsed;
  sleep = (milliseconds: number): Promise<void> => {
    this.sleeps.push(milliseconds);
    this.elapsed += milliseconds;
    this.onSleep?.();
    return Promise.resolve();
  };
}
type Effect =
  | 'database'
  | 'provision'
  | 'broker'
  | 'brokerAccess'
  | 'history'
  | 'stop'
  | 'backup'
  | 'migrate'
  | 'start'
  | 'gateway'
  | 'observe'
  | 'diagnostics'
  | 'stopFailed';
/** Independent resource state: never reads installation, transition or Compose files. */
export class MemoryInstallationRuntime implements InstallationRuntime {
  processes = new Map<string, { image: string; process: string }>();
  databases = new Map<string, 'running' | 'stopped'>();
  provisioned = new Set<string>();
  broker = false;
  migrations = new Map<string, number>();
  backups: string[] = [];
  evidence = new Map<string, unknown>();
  migrationEvidence = '';
  unknownMigrations: string[] = [];
  failures = new Map<Effect, 'before' | 'after'>();
  onEffect?: (effect: Effect) => void;
  onObserve?: () => void;
  cleanupAttempts: string[] = [];
  constructor(public signal: AbortSignal) {}
  private async effect<T>(
    name: Effect,
    action: () => T,
    cleanup = false,
  ): Promise<T> {
    if (!cleanup) this.signal.throwIfAborted();
    if (this.failures.get(name) === 'before')
      throw new Error(`${name} failed before effect`);
    const result = await Promise.resolve(action());
    this.onEffect?.(name);
    if (this.failures.get(name) === 'after')
      throw new Error(`${name} failed after effect`);
    if (!cleanup) this.signal.throwIfAborted();
    return result;
  }
  startDatabase: InstallationRuntime['startDatabase'] = (application: string) =>
    this.effect('database', () => {
      this.databases.set(application, 'running');
    });
  provisionDatabase: InstallationRuntime['provisionDatabase'] = (
    application: string,
  ) =>
    this.effect('provision', () => {
      this.provisioned.add(application);
    });
  startBroker: InstallationRuntime['startBroker'] = () =>
    this.effect('broker', () => {
      this.broker = true;
    });
  verifyBroker: InstallationRuntime['verifyBroker'] = () =>
    this.effect('brokerAccess', () => {});
  inspectMigrations: InstallationRuntime['inspectMigrations'] = () =>
    this.effect('history', () => ({
      evidence: this.migrationEvidence,
      unknown: this.unknownMigrations,
    }));
  stopApplication: InstallationRuntime['stopApplication'] = (
    application: string,
  ) =>
    this.effect('stop', () => {
      const process = this.processes.get(application);
      if (process) process.process = 'exited';
    });
  backup: InstallationRuntime['backup'] = (_target: Artifact, path: string) =>
    this.effect('backup', () => {
      this.backups.push(path);
      return path;
    });
  migrate: InstallationRuntime['migrate'] = (target: Artifact) =>
    this.effect('migrate', () => {
      const app = target.declaration.name;
      this.migrations.set(app, (this.migrations.get(app) ?? 0) + 1);
    });
  startCandidate: InstallationRuntime['startCandidate'] = (target: Artifact) =>
    this.effect('start', () => {
      this.processes.set(target.declaration.name, {
        image: target.image,
        process: 'running',
      });
    });
  refreshGateway: InstallationRuntime['refreshGateway'] = () =>
    this.effect('gateway', () => {});
  observeCandidate: InstallationRuntime['observeCandidate'] = (
    target: Artifact,
    cleanup = false,
  ) =>
    this.effect(
      'observe',
      () => {
        this.onObserve?.();
        const process = this.processes.get(target.declaration.name);
        return applicationRuntime(target, {
          container: process ? `${target.declaration.name}-container` : '',
          image: process?.image ?? '',
          process: process?.process ?? 'missing',
          health: this.evidence.get(target.declaration.name),
        });
      },
      cleanup,
    );
  collectCandidateDiagnostics: InstallationRuntime['collectCandidateDiagnostics'] =
    (application: string) => {
      this.cleanupAttempts.push(`diagnostics:${application}`);
      return this.effect('diagnostics', () => {}, true);
    };
  stopFailedCandidate: InstallationRuntime['stopFailedCandidate'] = (
    application: string,
  ) => {
    this.cleanupAttempts.push(`stop:${application}`);
    return this.effect(
      'stopFailed',
      () => {
        const process = this.processes.get(application);
        if (process) process.process = 'exited';
      },
      true,
    );
  };
}
interface InstallationFixture {
  directory: string;
  id: string;
  target: Artifact;
  previous: Artifact | null;
  sibling: Artifact;
  controller: AbortController;
  runtime: MemoryInstallationRuntime;
  clock: ManualVerificationClock;
  connect: (signal?: AbortSignal) => ReturnType<typeof operationsPromotion>;
  state: () => InstallationState;
  transition: () => ReturnType<typeof transitionSchema.parse>;
  cleanup: () => void;
}
function createInstallationFixture(
  target = artifact(),
  previous: Artifact | null = artifact('user', 'a'),
): InstallationFixture {
  const directory = mkdtempSync(join(tmpdir(), 'ddh-runtime-'));
  const id = randomUUID();
  const controller = new AbortController();
  const runtime = new MemoryInstallationRuntime(controller.signal);
  const clock = new ManualVerificationClock();
  const sibling = artifact('wallet', 'c');
  const state: InstallationState = {
    version: 2,
    name: 'example',
    project: 'owned',
    owner: 'owner',
    directory,
    applied: { applications: [...(previous ? [previous] : []), sibling] },
    retained: { databases: [] },
  };
  state.retained = retainResources(state, state.applied.applications);
  writeJson(join(directory, 'state.json'), state);
  for (const app of state.applied.applications) {
    runtime.processes.set(app.declaration.name, {
      image: app.image,
      process: 'running',
    });
    if (app.declaration.persistence)
      runtime.databases.set(app.declaration.name, 'running');
  }
  runtime.evidence.set(target.declaration.name, health(target));
  const connect = (signal = controller.signal) => {
    runtime.signal = signal;
    const current = stateSchema.parse(readJson(join(directory, 'state.json')));
    return operationsPromotion({
      store: {
        current,
        save: () => {
          writeJson(join(directory, 'state.json'), current);
        },
        saveCompose: (selection = current) => {
          writeJson(join(directory, 'rendered-selection.json'), selection);
        },
      },
      runtime,
      clock,
      signal,
      diagnostics: { logPath: join(directory, 'operation.log') },
    });
  };
  return {
    directory,
    id,
    target,
    previous,
    sibling,
    controller,
    runtime,
    clock,
    connect,
    state: () => stateSchema.parse(readJson(join(directory, 'state.json'))),
    transition: () =>
      transitionSchema.parse(
        readJson(join(directory, `transition-${id}.json`)),
      ),
    cleanup: () => {
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

export const installationFixture = createInstallationFixture;

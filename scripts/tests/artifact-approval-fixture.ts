import type { ApplicationDeclaration } from '@starter/capabilities/declaration';
import type {
  ApprovalClock,
  KongAdmin,
  KongEntity,
  KongTarget,
  ApprovalEnvironment,
  PlatformImageRuntime,
} from '../lib/artifact-approval';

export class ManualClock implements ApprovalClock {
  elapsed = 0;
  now(): number {
    return this.elapsed;
  }
  sleep(milliseconds: number): Promise<void> {
    this.elapsed += milliseconds;
    return Promise.resolve();
  }
}
export const readyRole = {
  status: 'ready',
  connected: true,
  failures: 0,
  retries: 0,
  retryDelayMs: 0,
  lastFailureAt: null,
  reason: null,
};
function initialState(app: ApplicationDeclaration) {
  return {
    platform: { platform: 'linux', arch: 'arm64' },
    migrationCode: 0,
    crossMigrationCode: 1,
    runtimeMigrationCode: 1,
    absentMigration: true,
    publishedPorts: '',
    hostReachable: false,
    startDelay: 0,
    probeDelay: 0,
    stopCode: 0,
    stopDelay: 0,
    running: false,
    cleaned: false,
    cleanupFailure: false,
    http: {
      status: 200,
      body: { service: 'reports', status: 'ready' } as unknown,
    },
    snapshot: {
      status: 200,
      body: {
        service: 'reports',
        lifecycle: 'running',
        http: { status: 'ready' },
        database: { status: app.persistence ? 'ready' : 'not_applicable' },
        consumer: app.messaging ? readyRole : { status: 'not_applicable' },
        publisher: { status: 'not_applicable' },
      } as unknown,
    },
  };
}

export function approvalFixture(
  overrides: Partial<ApplicationDeclaration> = {},
): {
  app: ApplicationDeclaration;
  clock: ManualClock;
  runtime: PlatformImageRuntime;
  state: ReturnType<typeof initialState>;
  image: string;
  platform: string;
  environment: ApprovalEnvironment;
} {
  const app: ApplicationDeclaration = {
    name: 'reports',
    persistence: false,
    messaging: false,
    exposure: false,
    ...overrides,
  };
  const clock = new ManualClock();
  const state = initialState(app);
  const runtime: PlatformImageRuntime = {
    executedPlatform: () => Promise.resolve(state.platform),
    migrate: (_action, settings = {}) => {
      if (!app.persistence && state.absentMigration)
        return Promise.resolve({ code: 1, stderr: 'Script not found' });
      return Promise.resolve({
        code: settings.DATABASE_APP
          ? state.crossMigrationCode
          : Object.keys(settings).length
            ? state.runtimeMigrationCode
            : state.migrationCode,
        stderr: '',
      });
    },
    start: () => {
      clock.elapsed += state.startDelay;
      state.running = true;
      return Promise.resolve();
    },
    publishedPorts: () => Promise.resolve(state.publishedPorts),
    hostReachable: () => Promise.resolve(state.hostReachable),
    probe: (path) => {
      clock.elapsed += state.probeDelay;
      return Promise.resolve(
        path === '/health/ready/http' ? state.http : state.snapshot,
      );
    },
    stop: () => {
      state.running = false;
      clock.elapsed += state.stopDelay;
      return Promise.resolve({ code: state.stopCode });
    },
    cleanup: () => {
      state.running = false;
      state.cleaned = true;
      if (state.cleanupFailure)
        return Promise.reject(new Error('Owned cleanup failed'));
      return Promise.resolve();
    },
  };
  return {
    app,
    clock,
    runtime,
    state,
    image: `sha256:${'a'.repeat(64)}`,
    platform: 'linux/arm64',
    environment: {
      environment: 'test' as const,
      topology: [app],
      applicationPorts: { reports: 3000 },
    },
  };
}

/** Scripted installed state and active checks, independent of configuration serialization. */
export class MemoryKong implements KongAdmin {
  mutated = false;
  unhealthyObserved = false;
  droppedMutation = false;
  changedAddress = false;
  servicesState: KongEntity[] = [];
  routesState: KongEntity[] = [];
  upstreamsState: KongEntity[] = [
    {
      id: 'upstream-id',
      name: 'app-reports',
      healthchecks: {
        active: {
          type: 'http',
          http_path: '/health/ready/http',
          healthy: { interval: 1, successes: 1, http_statuses: [200] },
          unhealthy: {
            interval: 1,
            http_failures: 1,
            tcp_failures: 1,
            timeouts: 1,
          },
        },
        passive: {
          healthy: { successes: 0 },
          unhealthy: { http_failures: 0, tcp_failures: 0, timeouts: 0 },
        },
      },
    },
  ];
  install(): Promise<void> {
    return Promise.resolve();
  }
  services(): Promise<KongEntity[]> {
    return Promise.resolve(this.servicesState);
  }
  routes(): Promise<KongEntity[]> {
    return Promise.resolve(this.routesState);
  }
  upstreams(): Promise<KongEntity[]> {
    return Promise.resolve(this.upstreamsState);
  }
  markUnhealthy(): Promise<void> {
    this.mutated = true;
    return Promise.resolve();
  }
  targetHealth(): Promise<KongTarget[]> {
    const unhealthy =
      this.mutated && !this.droppedMutation && !this.unhealthyObserved;
    if (unhealthy) this.unhealthyObserved = true;
    return Promise.resolve([
      {
        id: 'target-id',
        target: 'app-reports:3000',
        data: {
          addresses: [
            {
              ip:
                this.changedAddress && this.unhealthyObserved && !unhealthy
                  ? '10.0.0.9'
                  : '10.0.0.2',
              port: 3000,
              health: unhealthy ? 'UNHEALTHY' : 'HEALTHY',
            },
          ],
        },
      },
    ]);
  }
}

import { CachedProbe } from './cached-probe';

export interface Readiness {
  status: 'ready' | 'not_ready' | 'not_applicable';
}

export interface HealthSnapshot {
  service: string;
  lifecycle: 'running' | 'draining' | 'stopping';
  http: Readiness;
  consumer: Readiness & MessagingState;
  publisher: Readiness;
}

interface MessagingState {
  connected: boolean;
  failures: number;
  retries: number;
  retryDelayMs: number;
  lastFailureAt: string | null;
}

interface HealthSources {
  database: () => Promise<void>;
  consumer: () => MessagingState;
  publisher?: () => MessagingState;
  backlog?: () => Promise<{
    pendingCount: number;
    oldestAgeSeconds: number | null;
  }>;
}

export interface BacklogSnapshot {
  service: string;
  status: 'available' | 'unavailable' | 'not_applicable';
  pendingCount?: number;
  oldestAgeSeconds?: number | null;
}

/** Coalesces concurrent database probes and caches their result for one second. */
export class ServiceHealth {
  lifecycle: HealthSnapshot['lifecycle'] = 'running';
  private readonly database: CachedProbe<void>;
  private readonly outbox?: CachedProbe<{
    pendingCount: number;
    oldestAgeSeconds: number | null;
  }>;

  constructor(
    readonly service: string,
    private readonly sources: HealthSources,
  ) {
    this.database = new CachedProbe(sources.database);
    if (sources.backlog) this.outbox = new CachedProbe(sources.backlog);
  }

  async snapshot(): Promise<HealthSnapshot> {
    const { available: database } =
      this.lifecycle === 'running'
        ? await this.database.read()
        : { available: false };
    const readiness = (
      state: MessagingState,
    ): Readiness & MessagingState & { reason: string | null } => ({
      ...state,
      status:
        database && this.lifecycle === 'running' && state.connected
          ? 'ready'
          : 'not_ready',
      reason:
        this.lifecycle !== 'running'
          ? this.lifecycle
          : !database
            ? 'database_unavailable'
            : state.connected
              ? null
              : 'messaging_unavailable',
    });
    return {
      service: this.service,
      lifecycle: this.lifecycle,
      http: {
        status:
          database && this.lifecycle === 'running' ? 'ready' : 'not_ready',
      },
      consumer: readiness(this.sources.consumer()),
      publisher: this.sources.publisher
        ? readiness(this.sources.publisher())
        : { status: 'not_applicable' },
    };
  }

  async backlog(): Promise<BacklogSnapshot> {
    if (!this.outbox)
      return { service: this.service, status: 'not_applicable' };
    if (this.lifecycle !== 'running')
      return { service: this.service, status: 'unavailable' };
    const result = await this.outbox.read();
    return result.available
      ? { service: this.service, status: 'available', ...result.value }
      : { service: this.service, status: 'unavailable' };
  }
}

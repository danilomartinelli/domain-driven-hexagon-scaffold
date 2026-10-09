import type { ReadinessSnapshot } from '@starter/capabilities/readiness';
import type { ApplicationDeclaration } from '@starter/capabilities/declaration';
import { CachedProbe } from './cached-probe';

export type HealthSnapshot = ReadinessSnapshot;
export type Readiness = ReadinessSnapshot['database'];

interface MessagingState {
  connected: boolean;
  failures: number;
  retries: number;
  retryDelayMs: number;
  lastFailureAt: string | null;
}

type MessagingReadiness = ReadinessSnapshot['consumer'];

/**
 * Supply exactly the probes of the declared capabilities: `database` when
 * persistence is enabled and the messaging roles the application really uses.
 */
interface HealthSources {
  database?: () => Promise<void>;
  consumer?: () => MessagingState;
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
  readonly service: string;
  private readonly database?: CachedProbe<void>;
  private readonly outbox?: CachedProbe<{
    pendingCount: number;
    oldestAgeSeconds: number | null;
  }>;

  constructor(
    declaration: ApplicationDeclaration,
    private readonly sources: HealthSources,
  ) {
    const { name, persistence, messaging } = declaration;
    // A mismatch would report a disabled dependency as failed or hide an enabled one.
    if (persistence !== Boolean(sources.database))
      throw new Error(
        `${name}: supply a database probe exactly when persistence is enabled`,
      );
    if (messaging !== Boolean(sources.consumer ?? sources.publisher))
      throw new Error(
        `${name}: supply consumer or publisher probes exactly when messaging is enabled`,
      );
    this.service = name;
    if (sources.database) this.database = new CachedProbe(sources.database);
    if (sources.backlog) this.outbox = new CachedProbe(sources.backlog);
  }

  async snapshot(): Promise<HealthSnapshot> {
    const running = this.lifecycle === 'running';
    const database: Readiness = !this.database
      ? { status: 'not_applicable' }
      : running && (await this.database.read()).available
        ? { status: 'ready' }
        : { status: 'not_ready' };
    const usable = running && database.status !== 'not_ready';
    const readiness = (
      source: (() => MessagingState) | undefined,
    ): MessagingReadiness => {
      if (!source) return { status: 'not_applicable' };
      const state = source();
      return {
        ...state,
        status: usable && state.connected ? 'ready' : 'not_ready',
        reason: !running
          ? this.lifecycle
          : database.status === 'not_ready'
            ? 'database_unavailable'
            : state.connected
              ? null
              : 'messaging_unavailable',
      };
    };
    return {
      service: this.service,
      lifecycle: this.lifecycle,
      http: { status: usable ? 'ready' : 'not_ready' },
      database,
      consumer: readiness(this.sources.consumer),
      publisher: readiness(this.sources.publisher),
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

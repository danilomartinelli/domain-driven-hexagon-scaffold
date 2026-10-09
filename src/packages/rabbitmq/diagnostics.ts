export interface MessagingSnapshot {
  connected: boolean;
  failures: number;
  retries: number;
  retryDelayMs: number;
  lastFailureAt: string | null;
}

/** Observes the messaging role; never connects or retries on a probe's behalf. */
export class MessagingDiagnostics {
  private connected = false;
  private blocked = false;
  private failures = 0;
  private retries = 0;
  private retryDelayMs = 0;
  private lastFailureAt: string | null = null;

  available(active = true): void {
    this.connected = active;
    this.retryDelayMs = 0;
  }

  unavailable(): void {
    this.connected = false;
    this.blocked = false;
  }

  setBlocked(blocked: boolean): void {
    this.blocked = blocked;
  }

  retry(delayMs: number): void {
    this.unavailable();
    this.failures++;
    this.retries++;
    this.retryDelayMs = delayMs;
    this.lastFailureAt = new Date().toISOString();
  }

  snapshot(): MessagingSnapshot {
    return {
      connected: this.connected && !this.blocked,
      failures: this.failures,
      retries: this.retries,
      retryDelayMs: this.retryDelayMs,
      lastFailureAt: this.lastFailureAt,
    };
  }
}

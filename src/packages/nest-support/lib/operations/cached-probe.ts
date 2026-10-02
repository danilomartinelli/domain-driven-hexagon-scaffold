type ProbeResult<T> = { available: true; value: T } | { available: false };

/** A timed-out query stays in flight: repeated probes cannot queue more work. */
export class CachedProbe<T> {
  private pending?: Promise<ProbeResult<T>>;
  private sample?: Promise<ProbeResult<T>>;
  private expiresAt = 0;

  constructor(private readonly query: () => Promise<T>) {}

  read(): Promise<ProbeResult<T>> {
    if (!this.sample || Date.now() >= this.expiresAt) {
      this.expiresAt = Infinity;
      this.pending ??= Promise.resolve()
        .then(this.query)
        .then(
          (value): ProbeResult<T> => ({ available: true, value }),
          (): ProbeResult<T> => ({ available: false }),
        )
        .finally(() => {
          this.pending = undefined;
        });
      let timer: ReturnType<typeof setTimeout>;
      const deadline = new Promise<ProbeResult<T>>((resolve) => {
        timer = setTimeout(() => {
          resolve({ available: false });
        }, 5_000);
      });
      this.sample = Promise.race([this.pending, deadline]).finally(() => {
        clearTimeout(timer);
        this.expiresAt = Date.now() + 1_000;
      });
    }
    return this.sample;
  }
}

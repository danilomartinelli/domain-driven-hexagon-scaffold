import type { Subprocess } from 'bun';

export class ServiceProcess {
  private child?: Subprocess<'ignore', 'pipe', 'pipe'>;
  private collected?: Promise<unknown>;
  output = '';
  constructor(readonly name: 'user' | 'wallet') {}

  get url(): string {
    return `http://127.0.0.1:${String(process.env[`${this.name.toUpperCase()}_HTTP_PORT`])}`;
  }

  async start(
    preload?: string,
    overrides: Record<string, string> = {},
  ): Promise<void> {
    if (this.child) throw new Error(`${this.name} already started`);
    const env: Record<string, string> = {};
    const sibling = this.name === 'user' ? 'WALLET_' : 'USER_';
    for (const [key, value] of Object.entries(process.env)) {
      if (
        value !== undefined &&
        !key.startsWith(sibling) &&
        !key.startsWith('DB_') &&
        !key.startsWith('DDH_') &&
        !key.includes('_MIGRATION_')
      )
        env[key] = value;
    }
    this.output = '';
    const child = Bun.spawn(
      [
        process.execPath,
        ...(preload ? ['--preload', preload] : []),
        `src/apps/${this.name}/main.ts`,
      ],
      {
        env: { ...env, ...overrides },
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    this.child = child;
    const collect = async (stream: ReadableStream<Uint8Array>) => {
      for await (const chunk of stream)
        this.output += new TextDecoder().decode(chunk);
    };
    this.collected = Promise.all([
      collect(child.stdout),
      collect(child.stderr),
    ]);
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null)
        throw new Error(`${this.name} exited: ${this.output}`);
      try {
        const response = await fetch(`${this.url}/docs-json`, {
          signal: AbortSignal.timeout(1_000),
        });
        if (response.ok) return;
      } catch {
        /* Poll the actual listener, within the startup deadline. */
      }
      await Bun.sleep(50);
    }
    throw new Error(`${this.name} did not start: ${this.output}`);
  }

  signal(signal: 'SIGTERM' | 'SIGINT' | 'SIGKILL'): void {
    if (!this.child) throw new Error(`${this.name} is not running`);
    this.child.kill(signal);
  }

  async waitForExit(): Promise<{ code: number; forced: boolean }> {
    const child = this.child;
    if (!child) throw new Error(`${this.name} is not running`);
    let forced = false;
    const timer = setTimeout(() => {
      forced = true;
      child.kill('SIGKILL');
    }, 18_000);
    try {
      const code = await child.exited;
      await this.collected;
      this.child = undefined;
      return { code, forced };
    } finally {
      clearTimeout(timer);
    }
  }

  async stop(): Promise<void> {
    if (!this.child) return;
    this.signal('SIGTERM');
    const result = await this.waitForExit();
    if (result.forced)
      throw new Error(`${this.name} required SIGKILL: ${this.output}`);
    if (result.code !== 0)
      throw new Error(
        `${this.name} exited with code ${String(result.code)}: ${this.output}`,
      );
  }
}

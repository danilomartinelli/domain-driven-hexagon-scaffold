import type { Subprocess } from 'bun';

export class ServiceProcess {
  private child?: Subprocess<'ignore', 'pipe', 'pipe'>;
  output = '';
  constructor(readonly name: 'user' | 'wallet') {}

  get url(): string {
    return `http://127.0.0.1:${String(process.env[`${this.name.toUpperCase()}_HTTP_PORT`])}`;
  }

  async start(preload?: string): Promise<void> {
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
        env,
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
    void collect(child.stdout);
    void collect(child.stderr);
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

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.child = undefined;
    child.kill('SIGTERM');
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, 15_000);
    try {
      await child.exited;
    } finally {
      clearTimeout(timer);
    }
  }
}

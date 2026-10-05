import { expect } from 'bun:test';
import { availablePort } from '../lib/environments';
import { withCleanup } from './cleanup';

export async function until(
  check: () => Promise<boolean>,
  timeout = 20_000,
  description = 'Generated application probe',
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(100);
  }
  throw new Error(`${description} timed out`);
}

export interface RunningApp {
  url: string;
  logs: () => string;
  stop: (signal?: 'SIGTERM' | 'SIGINT') => Promise<void>;
}

/** Start a generated app with only the supplied settings and an owned HTTP port. */
export async function withApp(
  {
    cwd,
    command,
    prefix = 'TELEMETRY',
    settings,
  }: {
    cwd: string;
    command: string[];
    prefix?: string;
    settings: Record<string, string>;
  },
  use: (app: RunningApp) => Promise<void>,
): Promise<void> {
  const port = await availablePort();
  const child = Bun.spawn([process.execPath, '--no-env-file', ...command], {
    cwd,
    env: {
      PATH: process.env.PATH,
      ...settings,
      [`${prefix}_HTTP_PORT`]: String(port),
    },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    detached: true,
  });
  let output = '';
  const collect = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream)
      output = (output + decoder.decode(chunk, { stream: true })).slice(
        -32_000,
      );
  };
  const logs = Promise.all([collect(child.stdout), collect(child.stderr)]);
  let stopped = false;
  const stop = async (signal: 'SIGTERM' | 'SIGINT' = 'SIGTERM') => {
    if (stopped) return;
    child.kill(signal);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const code = await Promise.race([
        child.exited,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(new Error('Generated application shutdown timed out'));
          }, 18_000);
        }),
      ]);
      await logs;
      expect(code, output).toBe(0);
      expect(output).toContain('shutdown.completed');
      expect(output).not.toContain('shutdown.timed_out');
      stopped = true;
    } finally {
      clearTimeout(timer);
    }
  };
  const url = `http://127.0.0.1:${String(port)}`;
  await withCleanup(async () => {
    try {
      await until(async () => {
        if (child.exitCode !== null)
          throw new Error(`Generated application exited: ${output}`);
        return fetch(`${url}/health/live`, {
          signal: AbortSignal.timeout(1_000),
        }).then(
          (response) => response.ok,
          () => false,
        );
      });
      await use({ url, stop, logs: () => output });
      await stop();
    } catch (error) {
      throw new Error(`${String(error)}\n${output}`, { cause: error });
    }
  }, [
    async () => {
      if (child.exitCode === null) {
        process.kill(-child.pid, 'SIGKILL');
        await child.exited;
      }
      await logs;
    },
  ]);
}

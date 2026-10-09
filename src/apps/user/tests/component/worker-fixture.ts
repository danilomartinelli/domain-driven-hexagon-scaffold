import { expect } from 'bun:test';
import type { Subprocess } from 'bun';
async function eventually(
  assertion: () => Promise<void>,
  timeout = 12_000,
): Promise<void> {
  const deadline = Date.now() + timeout;
  for (;;) {
    try {
      await assertion();
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await Bun.sleep(50);
    }
  }
}

export interface ConsumerWorker {
  process: Subprocess<'pipe', 'pipe', 'pipe'>;
  waitFor(text: string, timeout?: number): Promise<void>;
  output(): string;
  kill(): Promise<void>;
}

export function startConsumerWorker(phase = 'normal'): ConsumerWorker {
  const worker = Bun.spawn(
    [process.execPath, 'src/apps/user/tests/component/consumer-worker.ts'],
    {
      env: { ...process.env, USER_TEST_CHECKPOINT: phase },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  let output = '';
  const collect = async (stream: ReadableStream<Uint8Array>) => {
    for await (const chunk of stream) output += new TextDecoder().decode(chunk);
  };
  void collect(worker.stdout);
  void collect(worker.stderr);
  return {
    process: worker,
    output: () => output,
    waitFor: (text, timeout) =>
      eventually(() => {
        expect(worker.exitCode, output).toBeNull();
        expect(output).toContain(text);
        return Promise.resolve();
      }, timeout),
    kill: async () => {
      worker.kill('SIGKILL');
      await worker.exited;
    },
  };
}

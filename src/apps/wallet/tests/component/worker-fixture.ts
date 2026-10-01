import { expect } from 'bun:test';
import type { Subprocess } from 'bun';
import { eventually } from './broker-fixture';

export interface ConsumerWorker {
  process: Subprocess<'ignore', 'pipe', 'pipe'>;
  waitFor(text: string): Promise<void>;
  kill(): Promise<void>;
}

export function startConsumerWorker(phase = 'normal'): ConsumerWorker {
  const worker = Bun.spawn(
    [process.execPath, 'src/apps/wallet/tests/component/consumer-worker.ts'],
    {
      env: { ...process.env, WALLET_TEST_CHECKPOINT: phase },
      stdin: 'ignore',
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
    waitFor: (text) =>
      eventually(() => {
        expect(worker.exitCode, output).toBeNull();
        expect(output).toContain(text);
        return Promise.resolve();
      }),
    kill: async () => {
      worker.kill('SIGKILL');
      await worker.exited;
    },
  };
}

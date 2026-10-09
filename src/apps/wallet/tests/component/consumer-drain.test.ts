import { expect, test } from 'bun:test';
import { withCleanup } from '../../../../../scripts/tests/cleanup';
import { startConsumerWorker } from './worker-fixture';
import { stopWallet } from './wallet-process';
import { withBroker, publish, userCreated } from './broker-fixture';

for (const shutdown of [false, true]) {
  test(`wallet keeps a timed-out transaction in flight during ${shutdown ? 'shutdown' : 'recovery'}`, async () => {
    await stopWallet();
    await withBroker(async (channel) => {
      const worker = startConsumerWorker('past-deadline');
      await withCleanup(async () => {
        await worker.waitFor('Wallet messaging connected.');
        await publish(channel, userCreated('drain-event', 'drain-user'));
        await worker.waitFor('CHECKPOINT:past-deadline');
        await worker.waitFor('Wallet delivery failed;', 15000);
        if (shutdown) worker.process.kill('SIGTERM');
        await Bun.sleep(750);
        if (shutdown) expect(worker.output()).not.toContain('CONSUMER:stopped');
        else expect(worker.output().match(/EXECUTION:/g)?.length).toBe(1);
        await worker.process.stdin.write('readiness\n');
        await worker.process.stdin.flush();
        await worker.waitFor('AVAILABLE:false');
        await worker.process.stdin.write('release\n');
        await worker.process.stdin.flush();
        if (shutdown) {
          expect(await worker.process.exited).toBe(0);
          const output = worker.output();
          expect(output).toContain('COMMIT:1');
          expect(output).toContain('CONSUMER:stopped');
          expect(output.indexOf('COMMIT:1')).toBeLessThan(
            output.indexOf('CONSUMER:stopped'),
          );
        } else {
          await worker.waitFor('EXECUTION:2');
          const output = worker.output();
          expect(output).toContain('COMMIT:1');
          expect(output.indexOf('COMMIT:1')).toBeLessThan(
            output.indexOf('EXECUTION:2'),
          );
        }
      }, [() => worker.kill()]);
    });
  }, 40_000);
}

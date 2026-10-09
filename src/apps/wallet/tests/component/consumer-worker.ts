import { createInterface } from 'node:readline';
import { assertTestEnvironment } from '../../../../../database/environment';
import { createPool } from 'slonik';
import { CreateWallet } from '../../application/create-wallet';
import type { WalletCreationTransaction } from '../../application/wallet-creation.port';
import {
  walletDatabaseUri,
  walletRabbitMqOptions,
} from '../../configs/environment';
import { SlonikWalletCreationTransaction } from '../../database/wallet-creation.adapter';
import { RabbitWalletConsumer } from '../../messaging/rabbit-wallet-consumer';

// Test-only process: pauses at the real transaction boundary, never at a mocked ACK.
assertTestEnvironment();
const pool = await createPool(walletDatabaseUri());
const transaction = new SlonikWalletCreationTransaction(pool);
const phase = process.env.WALLET_TEST_CHECKPOINT;
async function pause(): Promise<void> {
  console.log(`CHECKPOINT:${phase ?? 'none'}`);
  await new Promise<never>(() => {
    /* The parent kills this process at this boundary. */
  });
}
const release = Promise.withResolvers<undefined>();

let attempts = 0;
const checkpoint: WalletCreationTransaction = {
  run: async (operation) => {
    const attempt = ++attempts;
    console.log(`EXECUTION:${String(attempt)}`);
    const result = await transaction.run(async (scope) => {
      const value = await operation(scope);
      if (phase === 'before-commit') await pause();
      if (phase === 'past-deadline' && attempt === 1) {
        console.log('CHECKPOINT:past-deadline');
        await release.promise;
      }
      return value;
    });
    console.log(`COMMIT:${String(attempt)}`);
    if (phase === 'after-commit') await pause();
    return result;
  },
};
const consumer = new RabbitWalletConsumer(
  walletRabbitMqOptions(),
  new CreateWallet(checkpoint),
  console,
);
consumer.start();
createInterface({ input: process.stdin }).on('line', (command) => {
  if (command === 'release') release.resolve(undefined);
  if (command === 'readiness')
    console.log(`AVAILABLE:${String(consumer.snapshot().connected)}`);
});
process.on('SIGTERM', () => {
  void consumer
    .stop()
    .then(() => {
      console.log('CONSUMER:stopped');
      return pool.end();
    })
    .then(() => process.exit(0));
});

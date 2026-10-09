import { createInterface } from 'node:readline';
import { assertTestEnvironment } from '../../../../../database/environment';
import { createPool } from 'slonik';
import { CreateUser } from '../../application/create-user';
import type { UserWriteTransaction } from '../../application/user-write.port';
import {
  userDatabaseUri,
  userRabbitMqOptions,
} from '../../configs/environment';
import { SlonikUserWriteTransaction } from '../../database/user-write-transaction';
import { UserMapper } from '../../user.mapper';
import { RabbitUserCommandConsumer } from '../../messaging/rabbit-user-command-consumer';

assertTestEnvironment();
const pool = await createPool(userDatabaseUri());
const transaction = new SlonikUserWriteTransaction(pool, new UserMapper());
const release = Promise.withResolvers<undefined>();

let attempts = 0;
const checkpoint: UserWriteTransaction = {
  run: async (operation) => {
    const attempt = ++attempts;
    console.log(`EXECUTION:${String(attempt)}`);
    const result = await transaction.run(async (scope) => {
      const value = await operation(scope);
      if (
        process.env.USER_TEST_CHECKPOINT === 'past-deadline' &&
        attempt === 1
      ) {
        console.log('CHECKPOINT:past-deadline');
        await release.promise;
      }
      return value;
    });
    console.log(`COMMIT:${String(attempt)}`);
    return result;
  },
};
const consumer = new RabbitUserCommandConsumer(
  userRabbitMqOptions(),
  new CreateUser(checkpoint),
  console,
);
consumer.start();
createInterface({ input: process.stdin }).on('line', (command) => {
  if (command === 'release') release.resolve(undefined);
  if (command === 'readiness')
    console.log(
      `AVAILABLE:${String(consumer.diagnostics.snapshot().connected)}`,
    );
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

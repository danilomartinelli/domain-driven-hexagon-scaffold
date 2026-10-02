import { runFailureQueueCli } from '@starter/rabbitmq/failure-queue';
import {
  decodeUserCreatedEvent,
  userCreatedDestination,
} from '@starter/integration-contracts/user-created';
import { walletRabbitMqOptions } from '../configs/environment';

await runFailureQueueCli(
  walletRabbitMqOptions(),
  {
    queue: userCreatedDestination.walletQueue,
    failureQueue: userCreatedDestination.walletFailureQueue,
  },
  (message) => decodeUserCreatedEvent(message.content),
);

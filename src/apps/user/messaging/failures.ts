import { runFailureQueueCli } from '@starter/rabbitmq/failure-queue';
import { userRabbitMqOptions } from '../configs/environment';
import {
  decodeUserCreateDelivery,
  userCreateDestination,
} from './user-create.contract';

await runFailureQueueCli(
  userRabbitMqOptions(),
  userCreateDestination,
  (message) => {
    const decoded = decodeUserCreateDelivery(
      message.content,
      message.properties,
    );
    if (!decoded.accepted) return decoded;
    return { accepted: true, requiredQueues: [decoded.replyTo] };
  },
);

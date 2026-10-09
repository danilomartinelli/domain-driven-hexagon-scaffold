import type { LoggerPort } from '@starter/core/logger';
import {
  RabbitConsumer,
  type ConnectionOptions,
} from '@starter/rabbitmq/consumer';
import {
  decodeUserCreatedEvent,
  userCreatedDestination,
} from '@starter/integration-contracts/user-created';
import type { CreateWallet } from '../application/create-wallet';
import { handleUserCreated } from './user-created-consumer';

/** Envelope interpretation stays with Wallet; the package owns the consumer. */
export class RabbitWalletConsumer extends RabbitConsumer {
  constructor(
    connection: ConnectionOptions,
    create: CreateWallet,
    logger: LoggerPort,
  ) {
    const {
      exchange,
      routingKey,
      walletQueue: queue,
      walletFailureQueue: failureQueue,
    } = userCreatedDestination;
    super({
      connection,
      queue,
      failureQueue,
      binding: { exchange, routingKey },
      prefetch: 4,
      deliveryDeadlineMs: 10_000,
      service: 'wallet',
      logger,
      handler: async (message, context) => {
        context.identify({
          eventId:
            typeof message.properties.messageId === 'string'
              ? message.properties.messageId
              : undefined,
        });
        const decoded = decodeUserCreatedEvent(message.content);
        if (decoded.accepted) {
          const messageId =
            typeof message.properties.messageId === 'string'
              ? message.properties.messageId
              : decoded.event.eventId;
          context.identify({
            messageId,
            eventId: messageId,
            correlationId:
              typeof message.properties.correlationId === 'string'
                ? message.properties.correlationId
                : decoded.event.correlationId,
          });
        }
        context.signal.throwIfAborted();
        const delivery = await handleUserCreated(message.content, create);
        if (!delivery.accepted)
          return { status: 'retained', reason: delivery.reason };
        const { eventId, correlationId } = delivery.event;
        logger.log('Wallet event committed.', {
          service: 'wallet',
          operation: 'wallet.event.committed',
          eventId,
          correlationId,
          redelivered: message.fields.redelivered,
        });
        return { status: 'completed' };
      },
    });
  }
}

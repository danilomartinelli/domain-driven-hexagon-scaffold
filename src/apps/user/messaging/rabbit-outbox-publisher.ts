import type { LoggerPort } from '@starter/core/logger';
import { userCreatedDestination } from '@starter/integration-contracts/user-created';
import {
  RabbitPublisher,
  type ConnectionOptions,
} from '@starter/rabbitmq/publisher';
import type { UserOutbox } from '../application/outbox.port';

/** Broker acceptance ends publication, never claims Wallet processing. */
export class RabbitOutboxPublisher extends RabbitPublisher {
  constructor(
    connection: ConnectionOptions,
    outbox: UserOutbox,
    logger: LoggerPort,
  ) {
    const { exchange, routingKey, walletQueue } = userCreatedDestination;
    super({
      connection,
      exchange,
      routingKey,
      queues: [walletQueue],
      logger,
      service: 'user',
      claim: async (publish) => {
        let identity: { eventId: string; correlationId: string } | undefined;
        const published = await outbox.publishNext(async (event) => {
          identity = {
            eventId: event.eventId,
            correlationId: event.correlationId,
          };
          await publish({
            body: Buffer.from(event.body),
            messageId: event.eventId,
            correlationId: event.correlationId,
            contentType: 'application/json',
            type: 'user.created',
          });
          logger.log(
            'User event routed and broker-confirmed; Wallet completion is independent.',
            { service: 'user', operation: 'outbox.confirmed', ...identity },
          );
        });
        if (published)
          logger.log(
            'User publication completion committed.',
            { service: 'user', operation: 'outbox.published' },
            identity,
          );
        return published;
      },
    });
  }
}

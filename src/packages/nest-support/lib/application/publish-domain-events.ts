import type { AggregateRoot } from '@starter/core/domain';
import type { LoggerPort } from '@starter/core/logger';
import type { EventEmitter2 } from '@nestjs/event-emitter';
import { randomUUID } from 'node:crypto';

export interface DomainEventPublication {
  id: string;
  correlationId: string;
  timestamp: number;
}

/** Transitional in-process dispatch, awaited inside the repository transaction.
 * This is not a durable outbox; the aggregate only records facts.
 */
export async function publishDomainEvents(
  aggregate: AggregateRoot<unknown>,
  correlationId: string,
  logger: LoggerPort,
  eventEmitter: EventEmitter2,
): Promise<void> {
  await Promise.all(
    aggregate.domainEvents.map(async (event) => {
      const publication: DomainEventPublication = {
        id: randomUUID(),
        correlationId,
        timestamp: Date.now(),
      };
      logger.debug(
        `[${correlationId}] "${event.constructor.name}" event ${publication.id} published for aggregate ${aggregate.constructor.name} : ${aggregate.id}`,
      );
      await eventEmitter.emitAsync(event.constructor.name, event, publication);
    }),
  );
  aggregate.clearEvents();
}

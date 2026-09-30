import type { CommandMetadata, DomainEvent } from '@starter/core/domain';
import type { LoggerPort } from '@starter/core/logger';
import type { EventEmitter2 } from '@nestjs/event-emitter';
import { randomUUID } from 'node:crypto';

export interface DomainEventPublication extends CommandMetadata {
  id: string;
}

/** Transitional in-process dispatch explicitly requested by an application adapter.
 * This is not a durable outbox; repositories and aggregates never publish.
 */
export async function publishDomainEvents(
  events: readonly DomainEvent[],
  metadata: CommandMetadata,
  logger: LoggerPort,
  eventEmitter: EventEmitter2,
): Promise<void> {
  for (const event of events) {
    const publication: DomainEventPublication = {
      ...metadata,
      id: randomUUID(),
    };
    logger.debug(
      `[${metadata.correlationId}] "${event.constructor.name}" event ${publication.id} for aggregate ${event.aggregateId}`,
    );
    await eventEmitter.emitAsync(event.constructor.name, event, publication);
  }
}

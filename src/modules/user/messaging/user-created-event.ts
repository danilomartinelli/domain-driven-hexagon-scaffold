import type { UserCreatedEvent } from '@starter/integration-contracts/user-created';
import type { UserCreatedDomainEvent } from '../domain/events/user-created.domain-event';

/** The outbox assigns these values once and retains them on retry/replay. */
export function userCreatedIntegrationEvent(
  fact: UserCreatedDomainEvent,
  metadata: Pick<
    UserCreatedEvent,
    'eventId' | 'occurredAt' | 'correlationId' | 'causationId'
  >,
): UserCreatedEvent {
  return {
    type: 'user.created',
    version: 1,
    source: 'user',
    ...metadata,
    data: { userId: fact.aggregateId },
  };
}

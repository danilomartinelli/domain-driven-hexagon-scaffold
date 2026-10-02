// Fixed compatible producer candidate, not a historical User release.
import type { UserCreatedEvent } from './baseline-consumer';

interface Pending {
  eventId: string;
  userId: string;
  occurredAt: string;
  correlationId: string;
  causationId: string;
}

export function userCreatedIntegrationEvent(
  pending: Pending,
): UserCreatedEvent & {
  traceparent: string;
  data: { userId: string; producerHint: string };
} {
  return {
    type: 'user.created',
    version: 1,
    source: 'user',
    eventId: pending.eventId,
    occurredAt: pending.occurredAt,
    correlationId: pending.correlationId,
    causationId: pending.causationId,
    traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
    data: { userId: pending.userId, producerHint: 'compatible-fixture' },
  };
}

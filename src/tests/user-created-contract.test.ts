import { expect, test } from 'bun:test';
import { decodeUserCreatedEvent } from '@starter/integration-contracts/user-created';
import { UserCreatedDomainEvent } from '../modules/user/domain/events/user-created.domain-event';
import { userCreatedIntegrationEvent } from '../modules/user/messaging/user-created-event';

test('User maps its fact to a serializable contract with a supplied stable publication identity', () => {
  const fact = new UserCreatedDomainEvent({
    aggregateId: 'user-42',
    email: 'private@example.com',
    country: 'BR',
    postalCode: 'private',
    street: 'private',
  });
  const metadata = {
    eventId: 'event-42',
    correlationId: 'request-42',
    causationId: 'command-42',
    occurredAt: '2026-09-30T12:00:00.000Z',
  };
  const body = JSON.stringify(userCreatedIntegrationEvent(fact, metadata));
  expect(JSON.parse(body) as unknown).toEqual({
    type: 'user.created',
    version: 1,
    source: 'user',
    ...metadata,
    data: { userId: 'user-42' },
  });
  expect(body).not.toContain('private');
  expect(decodeUserCreatedEvent(body).accepted).toBe(true);
  expect(JSON.stringify(userCreatedIntegrationEvent(fact, metadata))).toBe(
    body,
  );
});

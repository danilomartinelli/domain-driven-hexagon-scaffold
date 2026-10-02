import { expect, test } from 'bun:test';
import { userCreatedIntegrationEvent } from '../../messaging/user-created-event';

test('the current User producer still emits the fixed initial v1 protocol without bootstrap', () => {
  expect(
    userCreatedIntegrationEvent({
      eventId: '4efebd63-a9d1-424d-990b-23c726cd7230',
      userId: '1f713fd5-ebcc-4954-981c-389628259a2d',
      occurredAt: '2026-09-30T12:00:00.000Z',
      correlationId: 'registration-42',
      causationId: 'create-user-42',
    }),
  ).toEqual({
    type: 'user.created',
    version: 1,
    source: 'user',
    eventId: '4efebd63-a9d1-424d-990b-23c726cd7230',
    occurredAt: '2026-09-30T12:00:00.000Z',
    correlationId: 'registration-42',
    causationId: 'create-user-42',
    data: { userId: '1f713fd5-ebcc-4954-981c-389628259a2d' },
  });
});

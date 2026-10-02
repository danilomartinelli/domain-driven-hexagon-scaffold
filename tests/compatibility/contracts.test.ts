import { expect, test } from 'bun:test';
import { decodeUserCreatedEvent as current } from '@starter/integration-contracts/user-created';
import { decodeUserCreatedEvent as baselineConsumer } from './fixtures/baseline-consumer';
import { decodeUserCreatedEvent as additiveConsumer } from './fixtures/additive-consumer';
import { userCreatedIntegrationEvent } from './fixtures/additive-producer';
import baseline from './fixtures/user-created-v1.json';

const additive = userCreatedIntegrationEvent({
  eventId: '4efebd63-a9d1-424d-990b-23c726cd7230',
  userId: '1f713fd5-ebcc-4954-981c-389628259a2d',
  occurredAt: '2026-09-30T12:00:00.000Z',
  correlationId: 'registration-42',
  causationId: 'create-user-42',
});

for (const [producerName, event] of [
  ['fixed baseline', baseline],
  ['compatible additive', additive],
] as const) {
  for (const [consumerName, consume] of [
    ['fixed baseline', baselineConsumer],
    ['compatible additive', additiveConsumer],
    ['current production', current],
  ] as const) {
    test(`${producerName} producer -> ${consumerName} consumer preserves the v1 fact`, () => {
      expect(consume(JSON.stringify(event))).toMatchObject({
        accepted: true,
        event: baseline,
      });
      expect(
        consume(new TextEncoder().encode(JSON.stringify(event))),
      ).toMatchObject({
        accepted: true,
        event: baseline,
      });
      expect(consume(JSON.stringify({ ...event, version: 2 })).accepted).toBe(
        false,
      );
      expect(consume(JSON.stringify({ ...event, data: {} })).accepted).toBe(
        false,
      );
    });
  }
}

test('the additive candidate actually emits and understands optional tracing while old consumers ignore it', () => {
  expect(additive).toMatchObject({
    traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
    data: { producerHint: 'compatible-fixture' },
  });
  expect(additiveConsumer(JSON.stringify(additive))).toMatchObject({
    accepted: true,
    event: { traceparent: additive.traceparent },
  });
  const oldResult: unknown = baselineConsumer(JSON.stringify(additive));
  const currentResult: unknown = current(JSON.stringify(additive));
  expect(oldResult).toEqual({ accepted: true, event: baseline });
  expect(currentResult).toEqual({ accepted: true, event: baseline });
});

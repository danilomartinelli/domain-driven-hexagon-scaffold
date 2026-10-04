import { expect, test } from 'bun:test';
import { decodeUserCreatedEvent } from '@starter/integration-contracts/user-created';
import baseline from './fixtures/user-created-v1.json';

test('the independent v1 baseline remains consumable with additive optional fields', () => {
  for (const envelope of [
    baseline,
    {
      ...baseline,
      traceparent: 'optional',
      data: { ...baseline.data, displayName: 'Ada' },
    },
  ]) {
    const result: unknown = decodeUserCreatedEvent(JSON.stringify(envelope));
    expect(result).toEqual({ accepted: true, event: baseline });
  }
  const bytes = new TextEncoder().encode(JSON.stringify(baseline));
  const decoded: unknown = decodeUserCreatedEvent(bytes);
  expect(decoded).toEqual({ accepted: true, event: baseline });
  expect(
    decodeUserCreatedEvent(
      JSON.stringify({
        ...baseline,
        eventId: 'valid-🌍',
        occurredAt: '2026-09-30T12:00:00-03:00',
      }),
    ).accepted,
  ).toBe(true);
});

test('retained v1 Unicode identities remain valid beyond the optional AMQP property byte limit', () => {
  const retained = {
    ...baseline,
    eventId: 'é'.repeat(128),
    correlationId: '🌍'.repeat(127),
  };
  const result: unknown = decodeUserCreatedEvent(JSON.stringify(retained));
  expect(result).toEqual({
    accepted: true,
    event: retained,
  });
});

test.each([
  '{',
  'null',
  '[]',
  JSON.stringify({ ...baseline, version: 2 }),
  JSON.stringify({ ...baseline, version: '1' }),
  JSON.stringify({ ...baseline, type: 'user.create' }),
  JSON.stringify({ ...baseline, source: 'wallet' }),
  JSON.stringify({ ...baseline, eventId: '' }),
  JSON.stringify({ ...baseline, eventId: 'bad\u0000event' }),
  JSON.stringify({ ...baseline, correlationId: 'bad\u0000correlation' }),
  JSON.stringify({ ...baseline, causationId: 'bad\u0000cause' }),
  JSON.stringify({ ...baseline, data: { userId: 'bad\u0000user' } }),
  JSON.stringify({ ...baseline, eventId: 'bad\ud800event' }),
  JSON.stringify({ ...baseline, data: { userId: 'bad\udc00user' } }),
  JSON.stringify({ ...baseline, correlationId: undefined }),
  JSON.stringify({ ...baseline, causationId: undefined }),
  JSON.stringify({ ...baseline, occurredAt: 'yesterday' }),
  JSON.stringify({ ...baseline, occurredAt: '0000-01-01T00:00:00Z' }),
  JSON.stringify({ ...baseline, occurredAt: '2026-09-30T12:00:00+16:00' }),
  JSON.stringify({ ...baseline, data: { email: 'private@example.com' } }),
])('invalid or unsupported envelopes are rejected: %s', (body) => {
  expect(decodeUserCreatedEvent(body).accepted).toBe(false);
});

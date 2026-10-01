import { expect, test } from 'bun:test';
import { decodeUserCreateCommand } from '../../messaging/user-create.contract';
import baseline from './fixtures/user-create-v1.json';

test('the version-one User command accepts additive fields and maps only profile data', () => {
  const body = JSON.stringify({
    ...baseline,
    future: true,
    data: { ...baseline.data, role: 'admin' },
  });
  expect(decodeUserCreateCommand(body)).toEqual({
    accepted: true,
    command: { ...baseline, type: 'user.create', version: 1 },
  });
});

test.each([
  null,
  { data: [] },
  { ...baseline, type: 'user.created' },
  { ...baseline, version: 2 },
  { ...baseline, commandId: '' },
  { ...baseline, correlationId: '\0' },
  { ...baseline, commandId: '\ud800' },
  { ...baseline, data: { ...baseline.data, email: 'invalid' } },
  { ...baseline, data: { ...baseline.data, country: 'UK' } },
  { ...baseline, data: { ...baseline.data, street: '123 Main' } },
  { ...baseline, data: { ...baseline.data, postalCode: 'NW1 6XE' } },
  { ...baseline, data: { ...baseline.data, country: 1234 } },
  { ...baseline, data: { email: 'command@example.com' } },
])('rejects invalid or unsupported command %j without a framework', (body) => {
  expect(decodeUserCreateCommand(JSON.stringify(body))).toEqual({
    accepted: false,
    reason: 'invalid-or-unsupported-user-create',
  });
});

test('rejects malformed JSON and invalid UTF-8', () => {
  expect(decodeUserCreateCommand('{')).toHaveProperty('accepted', false);
  expect(decodeUserCreateCommand(new Uint8Array([0xff]))).toHaveProperty(
    'accepted',
    false,
  );
});

test('command identities must fit AMQP short strings in UTF-8 bytes', () => {
  expect(
    decodeUserCreateCommand(
      JSON.stringify({ ...baseline, correlationId: 'é'.repeat(128) }),
    ),
  ).toHaveProperty('accepted', false);
});

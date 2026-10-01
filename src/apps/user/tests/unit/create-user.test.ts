import { expect, test } from 'bun:test';
import { rejects } from 'node:assert/strict';
import { CreateUser } from '../../application/create-user';
import { DeleteUser } from '../../application/delete-user';
import { UserAlreadyExistsError } from '../../domain/user.errors';
import { MemoryUserWrites } from './fixtures/memory-user-writes';

const input = {
  id: 'user-1',
  eventId: 'event-1',
  createdAt: new Date('2026-09-30T12:00:00Z'),
  email: 'alice@example.com',
  country: 'England',
  street: 'Baker street',
  postalCode: 'NW16XE',
};
const metadata = {
  correlationId: 'request-1',
  causationId: 'command-1',
  timestamp: 1790769600000,
};

test('creation atomically records a profile and stable pending creation identity without infrastructure', async () => {
  const store = new MemoryUserWrites();
  const result = await new CreateUser(store).execute(input, metadata);
  expect(result.unwrap()).toBe('user-1');
  expect(store.users.get('user-1')?.getProps().email).toBe('alice@example.com');
  expect(store.pending).toEqual([
    {
      eventId: 'event-1',
      userId: 'user-1',
      occurredAt: '2026-09-30T12:00:00.000Z',
      correlationId: 'request-1',
      causationId: 'command-1',
    },
  ]);
});

test('failure recording pending creation rolls back the inserted profile', async () => {
  const store = new MemoryUserWrites();
  store.recordingFailure = new Error('Outbox unavailable');
  await rejects(
    new CreateUser(store).execute(input, metadata),
    /Outbox unavailable/,
  );
  expect(store.users.size).toBe(0);
  expect(store.pending).toEqual([]);
});

test('duplicate email records no additional pending event', async () => {
  const store = new MemoryUserWrites();
  const create = new CreateUser(store);
  await create.execute(input, metadata);
  const original = structuredClone(store.pending);
  const duplicate = await create.execute(
    { ...input, id: 'user-2', eventId: 'event-2' },
    metadata,
  );
  expect(duplicate.unwrapErr()).toBeInstanceOf(UserAlreadyExistsError);
  expect(store.users.size).toBe(1);
  expect(store.pending).toEqual(original);
});

test('profile deletion retains its pending creation and missing deletion stays not found', async () => {
  const store = new MemoryUserWrites();
  await new CreateUser(store).execute(input, metadata);
  const pending = structuredClone(store.pending);
  const remove = new DeleteUser(store);
  expect((await remove.execute({ userId: input.id })).unwrap()).toBe(true);
  expect(store.users.size).toBe(0);
  expect(store.pending).toEqual(pending);
  expect((await remove.execute({ userId: input.id })).isErr()).toBe(true);
});

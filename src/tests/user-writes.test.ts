import { expect, test } from 'bun:test';
import { rejects } from 'node:assert/strict';
import { CreateUser } from '@modules/user/application/create-user';
import { DeleteUser } from '@modules/user/application/delete-user';
import { UserDeletedDomainEvent } from '@modules/user/domain/events/user-deleted.domain-event';
import { UserCreatedDomainEvent } from '@modules/user/domain/events/user-created.domain-event';
import { UserRoles } from '@modules/user/domain/user.types';
import { UserAlreadyExistsError } from '@modules/user/domain/user.errors';
import {
  ArgumentOutOfRangeException,
  NotFoundException,
} from '@starter/core/errors';
import { MemoryUserWrites } from './fixtures/memory-user-writes';

const input = {
  id: 'user-1',
  createdAt: new Date('2026-09-30T12:00:00Z'),
  email: 'alice@example.com',
  country: 'England',
  street: 'Baker street',
  postalCode: 'NW1',
};
const metadata = {
  correlationId: 'request-1',
  causationId: 'command-1',
  timestamp: 1790769600000,
};

test('creation commits a guest profile and its fact with explicit metadata without infrastructure', async () => {
  const store = new MemoryUserWrites();
  const result = await new CreateUser(store).execute(input, metadata);

  expect(result.unwrap()).toBe('user-1');
  const user = store.users.get('user-1');
  expect(user?.getProps()).toMatchObject({
    email: 'alice@example.com',
    role: UserRoles.guest,
    createdAt: new Date('2026-09-30T12:00:00Z'),
  });
  expect(user?.getProps().address.unpack()).toEqual({
    country: 'England',
    street: 'Baker street',
    postalCode: 'NW1',
  });
  expect(store.facts).toEqual([
    {
      event: new UserCreatedDomainEvent({
        aggregateId: 'user-1',
        email: 'alice@example.com',
        country: 'England',
        street: 'Baker street',
        postalCode: 'NW1',
      }),
      metadata,
    },
  ]);
});

test('duplicate email keeps the original profile and records no extra fact', async () => {
  const store = new MemoryUserWrites();
  const create = new CreateUser(store);
  await create.execute(input, metadata);
  const facts = [...store.facts];
  const result = await create.execute({ ...input, id: 'user-2' }, metadata);
  expect(result.unwrapErr()).toBeInstanceOf(UserAlreadyExistsError);
  expect([...store.users.keys()]).toEqual(['user-1']);
  expect(store.facts).toEqual(facts);
});

test('invalid address rejects creation without persisting a profile or fact', async () => {
  const store = new MemoryUserWrites();
  await rejects(
    new CreateUser(store).execute({ ...input, country: 'E' }, metadata),
    ArgumentOutOfRangeException,
  );
  expect(store.users.size).toBe(0);
  expect(store.facts).toEqual([]);
});

test('missing User returns the existing not-found result without recording deletion', async () => {
  const store = new MemoryUserWrites();
  const result = await new DeleteUser(store).execute(
    { userId: 'missing' },
    metadata,
  );
  expect(result.unwrapErr()).toBeInstanceOf(NotFoundException);
  expect(store.facts).toEqual([]);
});

test('creation rolls back the profile when recording its fact fails', async () => {
  const store = new MemoryUserWrites();
  const failure = new Error('Recording unavailable');
  store.recordingFailure = failure;
  await rejects(
    new CreateUser(store).execute(input, metadata),
    (error) => error === failure,
  );
  expect(store.users.size).toBe(0);
  expect(store.facts).toEqual([]);
});

test('deletion rolls back the profile and history when recording its fact fails', async () => {
  const store = new MemoryUserWrites();
  await new CreateUser(store).execute(input, metadata);
  const facts = [...store.facts];
  const failure = new Error('Recording unavailable');
  store.recordingFailure = failure;
  await rejects(
    new DeleteUser(store).execute({ userId: 'user-1' }, metadata),
    (error) => error === failure,
  );
  expect([...store.users.keys()]).toEqual(['user-1']);
  expect(store.users.get('user-1')?.domainEvents).toEqual([]);
  expect(store.facts).toEqual(facts);
});

test('deletion removes the profile and records its fact without rewriting creation history', async () => {
  const store = new MemoryUserWrites();
  await new CreateUser(store).execute(input, metadata);
  const creation = [...store.facts];

  const result = await new DeleteUser(store).execute(
    { userId: 'user-1' },
    metadata,
  );

  expect(result.unwrap()).toBe(true);
  expect(store.users.size).toBe(0);
  expect(store.facts).toEqual([
    ...creation,
    { event: new UserDeletedDomainEvent({ aggregateId: 'user-1' }), metadata },
  ]);
});

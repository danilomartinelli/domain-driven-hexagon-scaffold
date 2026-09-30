import { expect, test } from 'bun:test';
import { rejects } from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { sql } from 'slonik';
import { CreateUser } from '@modules/user/application/create-user';
import { DeleteUser } from '@modules/user/application/delete-user';
import { UserEntity } from '@modules/user/domain/user.entity';
import { UserCreatedDomainEvent } from '@modules/user/domain/events/user-created.domain-event';
import { UserDeletedDomainEvent } from '@modules/user/domain/events/user-deleted.domain-event';
import { Address } from '@modules/user/domain/value-objects/address.value-object';
import { UserMapper } from '@modules/user/user.mapper';
import { WalletMapper } from '@modules/wallet/wallet.mapper';
import { SlonikUserWriteTransaction } from '@src/infrastructure/user-write-transaction';
import type { DomainEventPublication } from '@starter/nest-support/events';
import {
  getHttpServer,
  getTestApplication,
  getTestDatabase,
} from '@tests/setup/test-server';
import { CreateUserMessageController } from '@modules/user/commands/create-user/create-user.message.controller';
import { CreateUserCliController } from '@modules/user/commands/create-user/create-user.cli.controller';
import { BadRequestException } from '@nestjs/common';

const profile = {
  email: 'ports@example.com',
  country: 'England',
  street: 'Baker street',
  postalCode: '28566',
};
const metadata = {
  correlationId: 'explicit-request',
  causationId: 'explicit-command',
  timestamp: 1790769600000,
};

function transaction(events = new EventEmitter2()): SlonikUserWriteTransaction {
  return new SlonikUserWriteTransaction(
    getTestDatabase(),
    new UserMapper(),
    new WalletMapper(),
    events,
  );
}

test.each(['message', 'CLI'] as const)(
  '%s adapter validates and delegates through CQRS without ambient context',
  async (adapter) => {
    const app = getTestApplication();
    const create =
      adapter === 'message'
        ? (email: string) =>
            app.get(CreateUserMessageController).create({ ...profile, email })
        : (email: string) =>
            app
              .get(CreateUserCliController)
              .createUser(
                email,
                profile.country,
                profile.postalCode,
                profile.street,
              );
    await rejects(create('invalid'), BadRequestException);
    expect(
      await getTestDatabase().any(sql.unsafe`SELECT id FROM users`),
    ).toEqual([]);
    await create(profile.email);
    expect(
      await getTestDatabase().any(sql.unsafe`SELECT email FROM users`),
    ).toEqual([{ email: 'ports@example.com' }]);
    expect(
      await getTestDatabase().any(sql.unsafe`SELECT balance FROM wallets`),
    ).toEqual([{ balance: 0 }]);
  },
);

test('transaction-scoped repository insertion and deletion persist without dispatching recorded events or creating Wallets', async () => {
  const events = new EventEmitter2();
  const publications: unknown[] = [];
  events.onAny((...args: unknown[]) => {
    publications.push(args);
  });
  const writes = transaction(events);
  const user = UserEntity.create(
    { email: profile.email, address: new Address(profile) },
    { id: randomUUID(), createdAt: new Date() },
  );

  await writes.run(async ({ users }) => {
    await users.insert(user);
  });
  expect(await getTestDatabase().any(sql.unsafe`SELECT id FROM users`)).toEqual(
    [{ id: user.id }],
  );
  expect(
    await getTestDatabase().any(sql.unsafe`SELECT id FROM wallets`),
  ).toEqual([]);
  expect(user.domainEvents).toHaveLength(1);
  user.clearEvents();
  user.delete();
  await writes.run(async ({ users }) => {
    await users.delete(user);
  });
  expect(await getTestDatabase().any(sql.unsafe`SELECT id FROM users`)).toEqual(
    [],
  );
  expect(user.domainEvents).toHaveLength(1);
  expect(publications).toEqual([]);
});

test('plain creation with real PostgreSQL supplies explicit publication metadata without a request context', async () => {
  const events = new EventEmitter2();
  const publications: DomainEventPublication[] = [];
  events.on(
    UserCreatedDomainEvent.name,
    (_event: UserCreatedDomainEvent, publication: DomainEventPublication) => {
      publications.push(publication);
    },
  );
  const result = await new CreateUser(transaction(events)).execute(
    { ...profile, id: randomUUID(), createdAt: new Date() },
    metadata,
  );
  expect(result.isOk()).toBe(true);
  expect(publications).toHaveLength(1);
  expect(publications[0]).toMatchObject(metadata);
  expect(publications[0]?.id).toBeString();
  expect(
    await getTestDatabase().any(
      sql.unsafe`SELECT "userId", balance FROM wallets`,
    ),
  ).toEqual([{ userId: result.unwrap(), balance: 0 }]);
});

test('failed fact dispatch rolls back both User and Wallet after persistence', async () => {
  const events = new EventEmitter2();
  const failure = new Error('Fact dispatch unavailable');
  events.on(UserCreatedDomainEvent.name, () => {
    throw failure;
  });
  await rejects(
    new CreateUser(transaction(events)).execute(
      { ...profile, id: randomUUID(), createdAt: new Date() },
      metadata,
    ),
    (error) => error === failure,
  );
  expect(await getTestDatabase().any(sql.unsafe`SELECT id FROM users`)).toEqual(
    [],
  );
  expect(
    await getTestDatabase().any(sql.unsafe`SELECT id FROM wallets`),
  ).toEqual([]);
});

test('failed deletion fact dispatch restores the profile and leaves its Wallet intact', async () => {
  const writes = transaction();
  const id = (
    await new CreateUser(writes).execute(
      { ...profile, id: randomUUID(), createdAt: new Date() },
      metadata,
    )
  ).unwrap();
  const events = new EventEmitter2();
  const failure = new Error('Deletion dispatch unavailable');
  events.on(UserDeletedDomainEvent.name, () => {
    throw failure;
  });
  await rejects(
    new DeleteUser(transaction(events)).execute({ userId: id }, metadata),
    (error) => error === failure,
  );
  expect(await getTestDatabase().any(sql.unsafe`SELECT id FROM users`)).toEqual(
    [{ id }],
  );
  expect(
    await getTestDatabase().any(
      sql.unsafe`SELECT "userId", balance FROM wallets`,
    ),
  ).toEqual([{ userId: id, balance: 0 }]);
  await getHttpServer().delete(`/v1/users/${id}`).expect(200);
  await getHttpServer().delete(`/v1/users/${id}`).expect(404);
});

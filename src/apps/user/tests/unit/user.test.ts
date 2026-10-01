import { expect, test } from 'bun:test';
import { UserEntity } from '../../domain/user.entity';
import { UserRoles } from '../../domain/user.types';
import { ArgumentOutOfRangeException } from '@starter/core/errors';
import { UserDeletedDomainEvent } from '../../domain/events/user-deleted.domain-event';
import { UserRoleChangedDomainEvent } from '../../domain/events/user-role-changed.domain-event';
import { UserAddressUpdatedDomainEvent } from '../../domain/events/user-address-updated.domain-event';
import { UserCreatedDomainEvent } from '../../domain/events/user-created.domain-event';
import { Address } from '../../domain/value-objects/address.value-object';

test('creating a User records its profile as a guest without a request context', () => {
  const user = UserEntity.create(
    {
      email: 'alice@example.com',
      address: new Address({
        country: 'England',
        street: 'Baker street',
        postalCode: 'NW1',
      }),
    },
    { id: 'user-1', createdAt: new Date('2026-09-29T12:00:00Z') },
  );

  expect(user.id).toBe('user-1');
  expect(user.createdAt.toISOString()).toBe('2026-09-29T12:00:00.000Z');
  expect(user.updatedAt).toEqual(user.createdAt);
  expect(user.role).toBe(UserRoles.guest);
  expect(user.domainEvents).toEqual([
    new UserCreatedDomainEvent({
      aggregateId: 'user-1',
      email: 'alice@example.com',
      country: 'England',
      street: 'Baker street',
      postalCode: 'NW1',
    }),
  ]);
});

test.each([
  { country: 'E', street: 'Baker street', postalCode: 'NW1' },
  { country: 'England', street: 'B', postalCode: 'NW1' },
  { country: 'England', street: 'Baker street', postalCode: 'N' },
  { country: 'England', street: 'Baker street', postalCode: '12345678901' },
])('Address rejects invalid lengths without infrastructure: %j', (props) => {
  expect(() => new Address(props)).toThrow(ArgumentOutOfRangeException);
});

test('User role changes, address replacement and deletion record ordered facts', () => {
  const user = UserEntity.create(
    {
      email: 'alice@example.com',
      address: new Address({
        country: 'England',
        street: 'Baker street',
        postalCode: 'NW1',
      }),
    },
    { id: 'user-1', createdAt: new Date(0) },
  );
  user.clearEvents();
  user.makeModerator();
  user.makeAdmin();
  user.updateAddress({
    country: 'France',
    street: 'Rue de Rivoli',
    postalCode: '75001',
  });
  user.delete();
  expect(user.role).toBe(UserRoles.admin);
  expect(user.getProps().address.country).toBe('France');
  expect(user.domainEvents).toEqual([
    new UserRoleChangedDomainEvent({
      aggregateId: 'user-1',
      oldRole: UserRoles.guest,
      newRole: UserRoles.moderator,
    }),
    new UserRoleChangedDomainEvent({
      aggregateId: 'user-1',
      oldRole: UserRoles.moderator,
      newRole: UserRoles.admin,
    }),
    new UserAddressUpdatedDomainEvent({
      aggregateId: 'user-1',
      country: 'France',
      street: 'Rue de Rivoli',
      postalCode: '75001',
    }),
    new UserDeletedDomainEvent({ aggregateId: 'user-1' }),
  ]);
  const recorded = user.domainEvents;
  user.clearEvents();
  expect(user.domainEvents).toEqual([]);
  expect(recorded).toHaveLength(4);
});

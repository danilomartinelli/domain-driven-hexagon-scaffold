import { expect, test } from 'bun:test';
import { Address } from '@modules/user/domain/value-objects/address.value-object';
import { UserEntity } from '@modules/user/domain/user.entity';
import { UserRoles } from '@modules/user/domain/user.types';
import { convertPropsToObject } from '@libs/utils';

test('property snapshots preserve data and dates without sharing mutable values', () => {
  const addressProps = {
    country: 'England',
    street: 'Baker street',
    postalCode: 'NW1',
  };
  const address = new Address(addressProps);
  const addresses: unknown[] = [address];
  const source = {
    addresses,
    recordedAt: new Date(0),
    nested: { labels: ['home'] },
  };
  const snapshot = convertPropsToObject(source);

  // Preserve the existing structured-clone shape of nested class instances.
  expect(snapshot).toEqual({
    addresses: [{ props: addressProps }],
    recordedAt: new Date(0),
    nested: { labels: ['home'] },
  });
  addressProps.street = 'Changed street';
  source.recordedAt.setUTCFullYear(2026);
  source.nested.labels.push('work');
  expect(snapshot.addresses).toEqual([
    {
      props: { country: 'England', street: 'Baker street', postalCode: 'NW1' },
    },
  ]);
  expect(snapshot.recordedAt).toEqual(new Date(0));
  expect(snapshot.nested.labels).toEqual(['home']);
});

test('Entity and ValueObject serialization retain their public shapes and freezing', () => {
  const addressProps = {
    country: 'England',
    street: 'Baker street',
    postalCode: 'NW1',
  };
  const address = new Address(addressProps);
  const user = UserEntity.create(
    { email: 'alice@example.com', address },
    { id: 'user-1', createdAt: new Date(0) },
  );
  const unpacked = address.unpack();
  const snapshot = user.toObject();

  expect(unpacked).toEqual(addressProps);
  expect(unpacked).not.toBe(addressProps);
  expect(Object.isFrozen(unpacked)).toBe(true);
  expect(snapshot).toEqual({
    id: 'user-1',
    createdAt: new Date(0),
    updatedAt: new Date(0),
    email: 'alice@example.com',
    role: UserRoles.guest,
    address: { props: addressProps },
  });
  expect(Object.isFrozen(snapshot)).toBe(true);
});

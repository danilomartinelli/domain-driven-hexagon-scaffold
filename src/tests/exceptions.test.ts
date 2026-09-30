import { expect, test } from 'bun:test';
import {
  ArgumentNotProvidedException,
  ConflictException,
} from '@starter/core/errors';
import { UserAlreadyExistsError } from '@modules/user/domain/user.errors';
import { WalletCreatedDomainEvent } from '@modules/wallet/domain/events/wallet-created.domain-event';

test('domain exceptions preserve their cause, code and safe metadata without ambient correlation', () => {
  const cause = new ConflictException('Record already exists');
  const error = new UserAlreadyExistsError(cause, { operation: 'create-user' });
  expect(error.cause).toBe(cause);
  expect(error.toJSON()).toMatchObject({
    message: 'User already exists',
    code: 'USER.ALREADY_EXISTS',
    metadata: { operation: 'create-user' },
  });
  expect(JSON.parse(JSON.stringify(error))).toMatchObject({
    code: 'USER.ALREADY_EXISTS',
  });
});

test('empty event inputs fail with domain argument errors', () => {
  // @ts-expect-error Runtime guard for untyped clients passing an absent input.
  expect(() => new WalletCreatedDomainEvent(undefined)).toThrow(
    ArgumentNotProvidedException,
  );
});

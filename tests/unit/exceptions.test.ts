import { expect, test } from 'bun:test';
import {
  ArgumentInvalidException,
  ArgumentNotProvidedException,
  ConflictException,
  NotFoundException,
} from '@libs/exceptions';
import { Command } from '@libs/ddd';
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
  expect(new NotFoundException().toJSON()).toMatchObject({
    message: 'Not found',
    code: 'GENERIC.NOT_FOUND',
  });
  expect(new ArgumentInvalidException('Invalid value').code).toBe(
    'GENERIC.ARGUMENT_INVALID',
  );
});

test('empty command and event inputs fail with domain argument errors', () => {
  // @ts-expect-error Runtime guard for untyped clients passing an absent input.
  expect(() => new Command(undefined)).toThrow(ArgumentNotProvidedException);
  // @ts-expect-error Runtime guard for untyped clients passing an absent input.
  expect(() => new WalletCreatedDomainEvent(undefined)).toThrow(
    ArgumentNotProvidedException,
  );
});

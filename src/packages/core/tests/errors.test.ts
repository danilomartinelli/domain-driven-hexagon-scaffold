import { expect, test } from 'bun:test';
import {
  ArgumentInvalidException,
  ArgumentNotProvidedException,
  NotFoundException,
} from '../errors';
import { Command } from '../domain';

test('generic exceptions preserve their codes and serializable messages', () => {
  expect(new NotFoundException().toJSON()).toMatchObject({
    message: 'Not found',
    code: 'GENERIC.NOT_FOUND',
  });
  expect(new ArgumentInvalidException('Invalid value').code).toBe(
    'GENERIC.ARGUMENT_INVALID',
  );
});

test('empty command inputs fail with domain argument errors', () => {
  // @ts-expect-error Runtime guard for untyped clients passing an absent input.
  expect(() => new Command(undefined)).toThrow(ArgumentNotProvidedException);
});

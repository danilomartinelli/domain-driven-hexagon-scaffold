import { expect, test } from 'bun:test';
import { ArgumentNotProvidedException } from '@starter/core/errors';
import { WalletCreatedDomainEvent } from '../../domain/events/wallet-created.domain-event';
test('empty event inputs fail with domain argument errors', () => {
  // @ts-expect-error Runtime guard for untyped clients passing an absent input.
  expect(() => new WalletCreatedDomainEvent(undefined)).toThrow(
    ArgumentNotProvidedException,
  );
});

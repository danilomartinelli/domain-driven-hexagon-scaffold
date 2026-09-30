import { ArgumentOutOfRangeException } from '@starter/core/errors';
import { expect, test } from 'bun:test';
import { WalletEntity } from '../../domain/wallet.entity';
import { WalletCreatedDomainEvent } from '../../domain/events/wallet-created.domain-event';

test('creating a Wallet records its owner and starts with zero balance', () => {
  const wallet = WalletEntity.create(
    { userId: 'user-1' },
    {
      id: 'wallet-1',
      createdAt: new Date('2026-09-29T12:00:00Z'),
    },
  );
  expect(wallet.getProps()).toMatchObject({
    id: 'wallet-1',
    userId: 'user-1',
    balance: 0,
  });
  expect(wallet.domainEvents).toEqual([
    new WalletCreatedDomainEvent({ aggregateId: 'wallet-1', userId: 'user-1' }),
  ]);
});

test('insufficient funds return a domain error and preserve the balance', () => {
  const wallet = WalletEntity.create(
    { userId: 'user-1' },
    { id: 'wallet-1', createdAt: new Date('2026-09-29T12:00:00Z') },
  );
  wallet.deposit(20);
  expect(wallet.withdraw(7).isOk()).toBe(true);
  const result = wallet.withdraw(14);
  expect(result.isErr()).toBe(true);
  expect(result.unwrapErr().toJSON()).toMatchObject({
    code: 'WALLET.NOT_ENOUGH_BALANCE',
    message: 'Wallet has not enough balance',
  });
  expect(wallet.getProps().balance).toBe(13);
});

test('Wallet rejects rehydrating a negative balance', () => {
  expect(
    () =>
      new WalletEntity({
        id: 'wallet-1',
        createdAt: new Date(0),
        props: { userId: 'user-1', balance: -1 },
      }),
  ).toThrow(ArgumentOutOfRangeException);
});

test('Wallet allows withdrawing the entire available balance', () => {
  const wallet = WalletEntity.create(
    { userId: 'user-1' },
    { id: 'wallet-1', createdAt: new Date(0) },
  );
  wallet.deposit(20);
  expect(wallet.withdraw(20).isOk()).toBe(true);
  expect(wallet.getProps().balance).toBe(0);
  expect(() => {
    wallet.validate();
  }).not.toThrow();
});

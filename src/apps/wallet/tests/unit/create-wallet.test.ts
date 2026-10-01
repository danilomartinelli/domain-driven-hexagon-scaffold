import { expect, test } from 'bun:test';
import { CreateWallet } from '../../application/create-wallet';
import type {
  WalletCreationTransaction,
  WalletCreationScope,
  WalletCreationEvent,
} from '../../application/wallet-creation.port';
import type { WalletSummary } from '../../application/wallet-read.port';

/** An atomic in-memory port, including a failure between its two durable writes. */
class MemoryTransaction implements WalletCreationTransaction {
  wallets = new Map<string, WalletSummary>();
  events = new Set<string>();
  failWalletWrite = false;

  async run<T>(
    operation: (scope: WalletCreationScope) => Promise<T>,
  ): Promise<T> {
    const wallets = new Map(this.wallets);
    const events = new Set(this.events);
    const result = await operation({
      claim: (event) => {
        if (events.has(event.eventId)) return Promise.resolve(false);
        events.add(event.eventId);
        return Promise.resolve(true);
      },
      insertIfAbsent: (wallet) => {
        if (this.failWalletWrite)
          return Promise.reject(new Error('write failed'));
        const { userId, balance } = wallet.getProps();
        if (!wallets.has(userId))
          wallets.set(userId, { id: wallet.id, userId, balance });
        return Promise.resolve();
      },
    });
    this.wallets = wallets;
    this.events = events;
    return result;
  }
}

const event: WalletCreationEvent = {
  eventId: 'event-1',
  userId: 'user-1',
  correlationId: 'request-1',
  causationId: 'command-1',
  occurredAt: '2026-09-30T12:00:00Z',
};
const identity = {
  id: 'wallet-1',
  createdAt: new Date('2026-09-30T12:01:00Z'),
};

test('creation records the event and one zero-balance Wallet in the same transaction', async () => {
  const db = new MemoryTransaction();
  const create = new CreateWallet(db);
  await create.execute(event, identity);
  expect([...db.wallets.values()]).toEqual([
    { id: 'wallet-1', userId: 'user-1', balance: 0 },
  ]);
  expect([...db.events]).toEqual(['event-1']);

  // Redelivery and a different event for the same user never replace a Wallet.
  db.wallets.set('user-1', { id: 'wallet-1', userId: 'user-1', balance: 75 });
  await create.execute(event, { ...identity, id: 'another-wallet' });
  await create.execute({ ...event, eventId: 'event-2' }, identity);
  expect([...db.wallets.values()]).toEqual([
    { id: 'wallet-1', userId: 'user-1', balance: 75 },
  ]);
  expect([...db.events]).toEqual(['event-1', 'event-2']);
});

test('a failed Wallet write leaves neither state committed and the same event can retry', async () => {
  const db = new MemoryTransaction();
  const create = new CreateWallet(db);
  db.failWalletWrite = true;
  const failure = await create
    .execute(event, identity)
    .catch((error: unknown) => error);
  expect(failure).toEqual(new Error('write failed'));
  expect(db.wallets.size).toBe(0);
  expect(db.events.size).toBe(0);
  db.failWalletWrite = false;
  await create.execute(event, identity);
  expect(db.wallets.size).toBe(1);
  expect(db.events.has('event-1')).toBe(true);
});

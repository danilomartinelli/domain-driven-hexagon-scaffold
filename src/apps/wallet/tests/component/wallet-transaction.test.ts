import { expect, test } from 'bun:test';
import { withCleanup } from '../../../../../scripts/tests/cleanup';
import { rejects } from 'node:assert/strict';
import { createPool } from 'slonik';
import { CreateWallet } from '../../application/create-wallet';
import { walletDatabaseUri } from '../../configs/environment';
import { SlonikWalletCreationTransaction } from '../../database/wallet-creation.adapter';
import { WalletEntity } from '../../domain/wallet.entity';
import { ownerDatabase, walletUrl } from './wallet-process';

const event = {
  eventId: 'event-atomic',
  userId: 'user-atomic',
  correlationId: 'correlation-atomic',
  causationId: 'cause-atomic',
  occurredAt: '2026-09-30T12:00:00Z',
};

test('real PostgreSQL rollback removes both Wallet and deduplication, allowing the same event to retry', async () => {
  const pool = await createPool(walletDatabaseUri());
  await withCleanup(async () => {
    const transaction = new SlonikWalletCreationTransaction(pool);
    await rejects(
      transaction.run(async (scope) => {
        await scope.claim(event);
        await scope.insertIfAbsent(
          WalletEntity.create(
            { userId: event.userId },
            { id: 'wallet-atomic', createdAt: new Date() },
          ),
        );
        throw new Error('abort before commit');
      }),
      /abort before commit/,
    );
    expect(
      (await ownerDatabase().query('SELECT * FROM wallet_consumed_events'))
        .rows,
    ).toEqual([]);
    expect(
      (await fetch(`${walletUrl()}/v1/wallets/by-user/${event.userId}`)).status,
    ).toBe(404);

    await new CreateWallet(transaction).execute(event, {
      id: 'wallet-atomic',
      createdAt: new Date(),
    });
    expect(
      await (
        await fetch(`${walletUrl()}/v1/wallets/by-user/${event.userId}`)
      ).json(),
    ).toMatchObject({ id: 'wallet-atomic', userId: event.userId, balance: 0 });
    expect(
      (
        await ownerDatabase().query(
          'SELECT event_id, user_id, correlation_id, causation_id FROM wallet_consumed_events',
        )
      ).rows,
    ).toEqual([
      {
        event_id: 'event-atomic',
        user_id: 'user-atomic',
        correlation_id: 'correlation-atomic',
        causation_id: 'cause-atomic',
      },
    ]);
  }, [() => pool.end()]);
});

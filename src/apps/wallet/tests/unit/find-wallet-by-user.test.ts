import { expect, test } from 'bun:test';
import { FindWalletByUser } from '../../application/find-wallet-by-user';
import type {
  WalletReadPort,
  WalletSummary,
} from '../../application/wallet-read.port';

/** Each User has at most one Wallet, so the lookup matches its user identity. */
class MemoryWalletReads implements WalletReadPort {
  constructor(private readonly wallets: readonly WalletSummary[]) {}

  findByUserId(userId: string): Promise<WalletSummary | undefined> {
    return Promise.resolve(
      this.wallets.find((wallet) => wallet.userId === userId),
    );
  }
}

const wallets: WalletSummary[] = [
  { id: 'wallet-1', userId: 'user-1', balance: 0 },
  { id: 'wallet-2', userId: 'user-2', balance: 25 },
];

test('the lookup returns the wallet identity, user identity and balance for a User without infrastructure', async () => {
  const findWalletByUser = new FindWalletByUser(new MemoryWalletReads(wallets));

  expect(await findWalletByUser.execute('user-2')).toEqual({
    id: 'wallet-2',
    userId: 'user-2',
    balance: 25,
  });
});

test('a User without a Wallet is a normal absent result, not an error', async () => {
  const findWalletByUser = new FindWalletByUser(new MemoryWalletReads(wallets));

  expect(await findWalletByUser.execute('user-3')).toBeUndefined();
  // Wallet identities are not user identities.
  expect(await findWalletByUser.execute('wallet-1')).toBeUndefined();
});

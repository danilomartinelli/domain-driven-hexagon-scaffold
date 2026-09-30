import { WalletEntity } from '../domain/wallet.entity';
import type {
  WalletCreationEvent,
  WalletCreationTransaction,
} from './wallet-creation.port';

export class CreateWallet {
  constructor(private readonly transaction: WalletCreationTransaction) {}

  async execute(
    event: WalletCreationEvent,
    identity: { id: string; createdAt: Date },
  ): Promise<void> {
    await this.transaction.run(async (scope) => {
      if (!(await scope.claim(event))) return;
      const wallet = WalletEntity.create({ userId: event.userId }, identity);
      await scope.insertIfAbsent(wallet);
    });
  }
}

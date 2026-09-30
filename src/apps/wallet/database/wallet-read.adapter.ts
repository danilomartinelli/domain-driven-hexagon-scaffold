import { Inject, Injectable } from '@nestjs/common';
import { type DatabasePool, sql } from 'slonik';
import type {
  WalletReadPort,
  WalletSummary,
} from '../application/wallet-read.port';
import { DATABASE_POOL } from './database.module';
import { walletSchema } from './wallet.schema';

/** The returned row must be a valid stored Wallet before its lookup fields are mapped. */
@Injectable()
export class SlonikWalletReadAdapter implements WalletReadPort {
  constructor(@Inject(DATABASE_POOL) private readonly pool: DatabasePool) {}

  async findByUserId(userId: string): Promise<WalletSummary | undefined> {
    const row = await this.pool.maybeOne(sql.type(walletSchema)`
      SELECT id, "createdAt", "updatedAt", balance, "userId"
      FROM wallets
      WHERE "userId" = ${userId}`);
    if (!row) return undefined;
    return { id: row.id, userId: row.userId, balance: row.balance };
  }
}

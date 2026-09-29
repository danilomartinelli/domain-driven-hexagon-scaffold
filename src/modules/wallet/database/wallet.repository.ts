import { Inject } from '@nestjs/common';
import { DATABASE_POOL } from '@libs/db/database.module';
import type { DatabasePool } from 'slonik';
import { z } from 'zod';
import { SqlRepositoryBase } from '@src/libs/db/sql-repository.base';
import type { WalletRepositoryPort } from './wallet.repository.port';
import { WalletEntity } from '../domain/wallet.entity';
import { WalletMapper } from '../wallet.mapper';
import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';

export const walletSchema = z.object({
  id: z.string().min(1).max(255),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  balance: z.number().min(0).max(9999999),
  userId: z.string().min(1).max(255),
});

export type WalletModel = z.TypeOf<typeof walletSchema>;

@Injectable()
export class WalletRepository
  extends SqlRepositoryBase<WalletEntity, WalletModel>
  implements WalletRepositoryPort
{
  protected tableName = 'wallets';

  protected schema = walletSchema;

  constructor(
    @Inject(DATABASE_POOL)
    pool: DatabasePool,
    mapper: WalletMapper,
    eventEmitter: EventEmitter2,
  ) {
    super(pool, mapper, eventEmitter, new Logger(WalletRepository.name));
  }
}

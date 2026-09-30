import { Inject } from '@nestjs/common';
import { DATABASE_POOL } from '@src/infrastructure/database.module';
import type { DatabasePool, DatabaseTransactionConnection } from 'slonik';
import { type WalletModel, walletSchema } from './wallet.schema';
import { SqlRepositoryBase } from '@starter/nest-support/persistence';
import type { WalletRepositoryPort } from './wallet.repository.port';
import { WalletEntity } from '../domain/wallet.entity';
import { WalletMapper } from '../wallet.mapper';
import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class WalletRepository
  extends SqlRepositoryBase<WalletEntity, WalletModel>
  implements WalletRepositoryPort
{
  protected tableName = 'wallets';

  protected schema = walletSchema;

  constructor(
    @Inject(DATABASE_POOL)
    pool: DatabasePool | DatabaseTransactionConnection,
    mapper: WalletMapper,
  ) {
    super(pool, mapper, new Logger(WalletRepository.name));
  }
}

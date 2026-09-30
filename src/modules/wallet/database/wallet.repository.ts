import { Inject } from '@nestjs/common';
import { DATABASE_POOL } from '@src/infrastructure/database.module';
import type { DatabasePool } from 'slonik';
import { type WalletModel, walletSchema } from './wallet.schema';
import { SqlRepositoryBase } from '@starter/nest-support/persistence';
import type { WalletRepositoryPort } from './wallet.repository.port';
import { WalletEntity } from '../domain/wallet.entity';
import { WalletMapper } from '../wallet.mapper';
import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';

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

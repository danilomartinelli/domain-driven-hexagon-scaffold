import type { DatabaseTransactionConnection } from 'slonik';
import { type WalletModel, walletSchema } from './wallet.schema';
import { SqlRepositoryBase } from '@starter/nest-support/persistence';
import type { WalletRepositoryPort } from './wallet.repository.port';
import { WalletEntity } from '../domain/wallet.entity';
import { WalletMapper } from '../wallet.mapper';
import { Logger } from '@nestjs/common';

export class WalletRepository
  extends SqlRepositoryBase<WalletEntity, WalletModel>
  implements WalletRepositoryPort
{
  protected tableName = 'wallets';

  protected schema = walletSchema;

  constructor(connection: DatabaseTransactionConnection, mapper: WalletMapper) {
    super(connection, mapper, new Logger(WalletRepository.name));
  }
}

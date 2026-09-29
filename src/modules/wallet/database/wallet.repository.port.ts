import type { RepositoryPort } from '@starter/core/domain';
import { WalletEntity } from '../domain/wallet.entity';

export type WalletRepositoryPort = RepositoryPort<WalletEntity>;

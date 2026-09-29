import { Logger, Module, type Provider } from '@nestjs/common';
import { CreateWalletWhenUserIsCreatedDomainEventHandler } from './application/event-handlers/create-wallet-when-user-is-created.domain-event-handler';
import { WalletRepository } from './database/wallet.repository';
import { WALLET_REPOSITORY } from './wallet.di-tokens';
import { WalletMapper } from './wallet.mapper';

const eventHandlers: Provider[] = [
  CreateWalletWhenUserIsCreatedDomainEventHandler,
];

const mappers: Provider[] = [WalletMapper];

const repositories: Provider[] = [
  { provide: WALLET_REPOSITORY, useClass: WalletRepository },
];

@Module({
  imports: [],
  controllers: [],
  providers: [Logger, ...eventHandlers, ...mappers, ...repositories],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- Nest requires a decorated module class.
export class WalletModule {}

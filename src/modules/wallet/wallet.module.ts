import { Logger, Module, type Provider } from '@nestjs/common';
import { WalletRepository } from './database/wallet.repository';
import { WALLET_REPOSITORY } from './wallet.di-tokens';
import { WalletMapper } from './wallet.mapper';

const mappers: Provider[] = [WalletMapper];

const repositories: Provider[] = [
  { provide: WALLET_REPOSITORY, useClass: WalletRepository },
];

@Module({
  imports: [],
  controllers: [],
  providers: [Logger, ...mappers, ...repositories],
  exports: [WalletMapper],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- Nest requires a decorated module class.
export class WalletModule {}

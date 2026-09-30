import { Logger, Module, type Provider } from '@nestjs/common';
import { WalletMapper } from './wallet.mapper';

const mappers: Provider[] = [WalletMapper];

@Module({
  imports: [],
  controllers: [],
  providers: [Logger, ...mappers],
  exports: [WalletMapper],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- Nest requires a decorated module class.
export class WalletModule {}

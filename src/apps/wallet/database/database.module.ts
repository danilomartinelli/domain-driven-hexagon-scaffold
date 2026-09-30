import { Global, Inject, Module } from '@nestjs/common';
import type { OnApplicationShutdown } from '@nestjs/common';
import { createPool } from 'slonik';
import type { DatabasePool } from 'slonik';
import { resultParser } from '@starter/nest-support/persistence';
import { walletDatabaseUri } from '../configs/environment';

export const DATABASE_POOL = Symbol('WALLET_DATABASE_POOL');

@Global()
@Module({
  providers: [
    {
      provide: DATABASE_POOL,
      useFactory: async (): Promise<DatabasePool> =>
        createPool(walletDatabaseUri(), { interceptors: [resultParser] }),
    },
  ],
  exports: [DATABASE_POOL],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(DATABASE_POOL) private readonly pool: DatabasePool) {}

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}

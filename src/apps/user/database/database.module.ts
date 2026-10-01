import { Global, Inject, Module } from '@nestjs/common';
import type { OnApplicationShutdown } from '@nestjs/common';
import { createPool } from 'slonik';
import type { DatabasePool } from 'slonik';
import { resultParser } from '@starter/nest-support/persistence';
import { userDatabaseUri } from '../configs/environment';

export const DATABASE_POOL = Symbol('USER_DATABASE_POOL');

@Global()
@Module({
  providers: [
    {
      provide: DATABASE_POOL,
      useFactory: async (): Promise<DatabasePool> =>
        createPool(userDatabaseUri(), {
          interceptors: [resultParser],
          connectionTimeout: 5_000,
          statementTimeout: 5_000,
        }),
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

import { Global, Inject, Module } from '@nestjs/common';
import type { OnApplicationShutdown } from '@nestjs/common';
import { createPool, SchemaValidationError } from 'slonik';
import type { DatabasePool, Interceptor, QueryResultRow } from 'slonik';
import { postgresConnectionUri } from '@config/database.config';

export const DATABASE_POOL = Symbol('DATABASE_POOL');

// sql.type carries a schema; Slonik requires an interceptor to validate rows.
const resultParser: Interceptor = {
  name: 'result-parser',
  async transformRowAsync(context, query, row) {
    if (!context.resultParser) return row;

    const result = await context.resultParser['~standard'].validate(row);
    if (result.issues) {
      throw new SchemaValidationError(query, row, result.issues);
    }
    // Slonik's interceptor type describes raw columns; schemas may coerce dates.
    return result.value as QueryResultRow;
  },
};

@Global()
@Module({
  providers: [
    {
      provide: DATABASE_POOL,
      useFactory: async (): Promise<DatabasePool> =>
        createPool(postgresConnectionUri, { interceptors: [resultParser] }),
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

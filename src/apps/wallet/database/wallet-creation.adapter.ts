import { type DatabasePool, sql } from 'slonik';
import type {
  WalletCreationScope,
  WalletCreationTransaction,
} from '../application/wallet-creation.port';

export class SlonikWalletCreationTransaction implements WalletCreationTransaction {
  constructor(private readonly pool: DatabasePool) {}

  run<T>(operation: (scope: WalletCreationScope) => Promise<T>): Promise<T> {
    return this.pool.transaction(async (connection) => {
      // Bound blocked writes so the delivery remains recoverable without wedging a consumer.
      await connection.query(sql.unsafe`SET LOCAL statement_timeout = '5s'`);
      return operation({
        claim: async (event) => {
          const result = await connection.query(sql.unsafe`
            INSERT INTO wallet_consumed_events (event_id, user_id, correlation_id, causation_id, occurred_at)
            VALUES (${event.eventId}, ${event.userId}, ${event.correlationId}, ${event.causationId}, ${event.occurredAt})
            ON CONFLICT (event_id) DO NOTHING`);
          return result.rowCount === 1;
        },
        insertIfAbsent: async (wallet) => {
          wallet.validate();
          const { id, userId, balance, createdAt, updatedAt } =
            wallet.getProps();
          await connection.query(sql.unsafe`
            INSERT INTO wallets (id, "userId", balance, "createdAt", "updatedAt")
            VALUES (${id}, ${userId}, ${balance}, ${createdAt.toISOString()}, ${updatedAt.toISOString()})
            ON CONFLICT ("userId") DO NOTHING`);
        },
      });
    });
  }
}

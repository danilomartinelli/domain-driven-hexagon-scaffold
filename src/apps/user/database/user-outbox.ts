import { type DatabasePool, sql } from 'slonik';
import { z } from 'zod';
import { decodeUserCreatedEvent } from '@starter/integration-contracts/user-created';
import type {
  PendingPublication,
  UserOutbox,
} from '../application/outbox.port';

export class SlonikUserOutbox implements UserOutbox {
  constructor(private readonly pool: DatabasePool) {}

  publishNext(
    publish: (event: PendingPublication) => Promise<void>,
  ): Promise<boolean> {
    // No automatic transaction retry around an external side effect. The publisher
    // owns backoff; rollback (including an uncertain commit) preserves the identity.
    return this.pool.transaction(async (connection) => {
      await connection.query(sql.unsafe`SET LOCAL statement_timeout = '5s'`);
      const pending = await connection.maybeOne(sql.type(
        z.object({
          event_id: z.string(),
          envelope: z.unknown(),
        }),
      )`
        SELECT event_id, envelope FROM user_outbox
        WHERE published_at IS NULL ORDER BY recorded_at, event_id
        LIMIT 1 FOR UPDATE SKIP LOCKED
      `);
      if (!pending) return false;
      const body = JSON.stringify(pending.envelope);
      const decoded = decodeUserCreatedEvent(body);
      if (!decoded.accepted) throw new Error('Invalid persisted User event');
      await publish({
        eventId: pending.event_id,
        correlationId: decoded.event.correlationId,
        body,
      });
      await connection.query(sql.unsafe`
        UPDATE user_outbox SET published_at = now() WHERE event_id = ${pending.event_id}
      `);
      return true;
    }, 0);
  }
}

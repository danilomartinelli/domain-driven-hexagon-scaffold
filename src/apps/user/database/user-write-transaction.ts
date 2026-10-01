import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { decodeUserCreatedEvent } from '@starter/integration-contracts/user-created';
import { type DatabasePool, sql } from 'slonik';
import type {
  UserWriteScope,
  UserWriteTransaction,
} from '../application/user-write.port';
import { UserRepository } from './user.repository';
import { UserMapper } from '../user.mapper';
import { userCreatedIntegrationEvent } from '../messaging/user-created-event';
import { DATABASE_POOL } from './database.module';

@Injectable()
export class SlonikUserWriteTransaction implements UserWriteTransaction {
  constructor(
    @Inject(DATABASE_POOL) private readonly pool: DatabasePool,
    private readonly mapper: UserMapper,
  ) {}

  run<T>(operation: (scope: UserWriteScope) => Promise<T>): Promise<T> {
    return this.pool.transaction(async (connection) => {
      const users = new UserRepository(connection, this.mapper);
      return operation({
        users: {
          insert: (user) => users.insert(user),
          findOneById: async (id) => {
            const user = await users.findOneById(id);
            return user.isSome() ? user.unwrap() : undefined;
          },
          delete: (user) => users.delete(user),
        },
        recordUserCreated: async (pending) => {
          const event = userCreatedIntegrationEvent(pending);
          if (!decodeUserCreatedEvent(JSON.stringify(event)).accepted) {
            throw new BadRequestException('Invalid integration event metadata');
          }
          await connection.query(sql.unsafe`
            INSERT INTO user_outbox (event_id, envelope)
            VALUES (${event.eventId}, ${sql.jsonb(event)})
          `);
        },
      });
    });
  }
}

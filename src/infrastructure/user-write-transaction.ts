import { Inject, Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { randomUUID } from 'node:crypto';
import type { DatabasePool } from 'slonik';
import type {
  UserWriteScope,
  UserWriteTransaction,
} from '@modules/user/application/user-write.port';
import { UserRepository } from '@modules/user/database/user.repository';
import { UserMapper } from '@modules/user/user.mapper';
import { UserCreatedDomainEvent } from '@modules/user/domain/events/user-created.domain-event';
import { WalletEntity } from '@modules/wallet/domain/wallet.entity';
import { WalletRepository } from '@modules/wallet/database/wallet.repository';
import { WalletMapper } from '@modules/wallet/wallet.mapper';
import { publishDomainEvents } from '@starter/nest-support/events';
import { DATABASE_POOL } from './database.module';

/** Transitional shared transaction. Replace Wallet coordination and in-process
 * dispatch with a User outbox at the asynchronous cutover (issue #15).
 */
@Injectable()
export class SlonikUserWriteTransaction implements UserWriteTransaction {
  private readonly logger = new Logger(SlonikUserWriteTransaction.name);

  constructor(
    @Inject(DATABASE_POOL) private readonly pool: DatabasePool,
    private readonly userMapper: UserMapper,
    private readonly walletMapper: WalletMapper,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  run<T>(operation: (scope: UserWriteScope) => Promise<T>): Promise<T> {
    return this.pool.transaction(async (connection) => {
      const users = new UserRepository(connection, this.userMapper);
      const wallets = new WalletRepository(connection, this.walletMapper);
      return operation({
        users: {
          insert: (user) => users.insert(user),
          findOneById: async (id) => {
            const found = await users.findOneById(id);
            return found.isSome() ? found.unwrap() : undefined;
          },
          delete: (user) => users.delete(user),
        },
        recordEvents: async (events, metadata) => {
          for (const event of events) {
            if (event instanceof UserCreatedDomainEvent) {
              const wallet = WalletEntity.create(
                { userId: event.aggregateId },
                { id: randomUUID(), createdAt: new Date() },
              );
              await wallets.insert(wallet);
              await publishDomainEvents(
                wallet.domainEvents,
                metadata,
                this.logger,
                this.eventEmitter,
              );
              wallet.clearEvents();
            }
          }
          await publishDomainEvents(
            events,
            metadata,
            this.logger,
            this.eventEmitter,
          );
        },
      });
    });
  }
}

import type { DomainEvent } from '@starter/core/domain';
import { ConflictException } from '@starter/core/errors';
import type {
  UserOperationMetadata,
  UserWriteScope,
  UserWriteTransaction,
} from '@modules/user/application/user-write.port';
import { UserEntity } from '@modules/user/domain/user.entity';

/** Copy-on-write port implementation: failures discard both profiles and facts. */
export class MemoryUserWrites implements UserWriteTransaction {
  users = new Map<string, UserEntity>();
  facts: { event: DomainEvent; metadata: UserOperationMetadata }[] = [];
  recordingFailure?: Error;

  async run<T>(operation: (scope: UserWriteScope) => Promise<T>): Promise<T> {
    const users = new Map(
      [...this.users].map(([id, user]) => {
        const { id: userId, createdAt, updatedAt, ...props } = user.getProps();
        return [
          id,
          new UserEntity({ id: userId, createdAt, updatedAt, props }),
        ];
      }),
    );
    const facts = [...this.facts];
    const result = await operation({
      users: {
        insert: (user) => {
          if (
            [...users.values()].some(
              (existing) => existing.getProps().email === user.getProps().email,
            )
          ) {
            return Promise.reject(
              new ConflictException('Record already exists'),
            );
          }
          users.set(user.id, user);
          return Promise.resolve();
        },
        findOneById: (id) => Promise.resolve(users.get(id)),
        delete: (user) => Promise.resolve(users.delete(user.id)),
      },
      recordEvents: (events, metadata) => {
        if (this.recordingFailure) return Promise.reject(this.recordingFailure);
        facts.push(...events.map((event) => ({ event, metadata })));
        return Promise.resolve();
      },
    });
    this.users = users;
    this.facts = facts;
    return result;
  }
}

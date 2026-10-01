import { ConflictException } from '@starter/core/errors';
import type {
  PendingUserCreated,
  UserWriteScope,
  UserWriteTransaction,
} from '../../../application/user-write.port';
import { UserEntity } from '../../../domain/user.entity';

/** Copy-on-write port implementation: failures discard both profiles and facts. */
export class MemoryUserWrites implements UserWriteTransaction {
  users = new Map<string, UserEntity>();
  pending: PendingUserCreated[] = [];
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
    const pending = [...this.pending];
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
      recordUserCreated: (event) => {
        if (this.recordingFailure) return Promise.reject(this.recordingFailure);
        pending.push(event);
        return Promise.resolve();
      },
    });
    this.users = users;
    this.pending = pending;
    return result;
  }
}

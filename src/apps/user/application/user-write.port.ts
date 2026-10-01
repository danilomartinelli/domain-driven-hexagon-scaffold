import type { UserEntity } from '../domain/user.entity';

export interface UserOperationMetadata {
  readonly correlationId: string;
  readonly causationId: string;
  readonly timestamp: number;
  readonly userId?: string;
}

/** Persistence alone never dispatches facts. These ports share one atomic scope. */
export interface UserWriteScope {
  readonly users: {
    /** Reject with the core ConflictException when uniqueness is violated. */
    insert(user: UserEntity): Promise<void>;
    findOneById(id: string): Promise<UserEntity | undefined>;
    delete(user: UserEntity): Promise<boolean>;
  };
  recordUserCreated(event: PendingUserCreated): Promise<void>;
}

export interface UserWriteTransaction {
  /** Commit persistence and recorded facts together; reject to roll back the scope. */
  run<T>(operation: (scope: UserWriteScope) => Promise<T>): Promise<T>;
}

/** Application-owned pending fact; the database adapter encodes the wire contract. */
export interface PendingUserCreated {
  readonly eventId: string;
  readonly userId: string;
  readonly occurredAt: string;
  readonly correlationId: string;
  readonly causationId: string;
}

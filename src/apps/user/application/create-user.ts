import type { AggregateID } from '@starter/core/domain';
import { ConflictException } from '@starter/core/errors';
import { Err, Ok, type Result } from 'oxide.ts';
import { UserEntity } from '../domain/user.entity';
import { UserAlreadyExistsError } from '../domain/user.errors';
import { Address } from '../domain/value-objects/address.value-object';
import type {
  UserOperationMetadata,
  UserWriteTransaction,
} from './user-write.port';

export interface CreateUserInput {
  readonly id: string;
  readonly eventId: string;
  readonly createdAt: Date;
  readonly email: string;
  readonly country: string;
  readonly postalCode: string;
  readonly street: string;
}

export type CreateUserResult = Result<AggregateID, UserAlreadyExistsError>;

export class CreateUser {
  constructor(private readonly transaction: UserWriteTransaction) {}

  async execute(
    input: CreateUserInput,
    metadata: UserOperationMetadata,
  ): Promise<CreateUserResult> {
    const user = UserEntity.create(
      {
        email: input.email,
        address: new Address({
          country: input.country,
          postalCode: input.postalCode,
          street: input.street,
        }),
      },
      { id: input.id, createdAt: input.createdAt },
    );
    try {
      await this.transaction.run(async (scope) => {
        await scope.users.insert(user);
        await scope.recordUserCreated({
          eventId: input.eventId,
          userId: user.id,
          occurredAt: input.createdAt.toISOString(),
          correlationId: metadata.correlationId,
          causationId: metadata.causationId,
        });
        user.clearEvents();
      });
      return Ok(user.id);
    } catch (error) {
      if (error instanceof ConflictException)
        return Err(new UserAlreadyExistsError(error));
      throw error;
    }
  }
}

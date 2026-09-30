import { NotFoundException } from '@starter/core/errors';
import { Err, Ok, type Result } from 'oxide.ts';
import type {
  UserOperationMetadata,
  UserWriteTransaction,
} from './user-write.port';

export interface DeleteUserInput {
  readonly userId: string;
}

export type DeleteUserResult = Result<boolean, NotFoundException>;

export class DeleteUser {
  constructor(private readonly transaction: UserWriteTransaction) {}

  execute(
    input: DeleteUserInput,
    metadata: UserOperationMetadata,
  ): Promise<DeleteUserResult> {
    return this.transaction.run(async (scope) => {
      const user = await scope.users.findOneById(input.userId);
      if (!user) return Err(new NotFoundException());
      const deleted = await scope.users.delete(user);
      if (deleted) {
        user.delete();
        await scope.recordEvents(user.domainEvents, metadata);
        user.clearEvents();
      }
      return Ok(deleted);
    });
  }
}

import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import {
  DeleteUser,
  type DeleteUserResult,
} from '../../application/delete-user';
import { DeleteUserCommand } from './delete-user.command';

@CommandHandler(DeleteUserCommand)
export class DeleteUserService implements ICommandHandler<DeleteUserCommand> {
  constructor(private readonly deleteUser: DeleteUser) {}

  execute(command: DeleteUserCommand): Promise<DeleteUserResult> {
    return this.deleteUser.execute({ userId: command.userId });
  }
}

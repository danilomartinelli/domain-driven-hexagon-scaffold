import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import { randomUUID } from 'node:crypto';
import { isUserCreatedIdentity } from '@starter/integration-contracts/user-created';
import {
  CreateUser,
  type CreateUserResult,
} from '../../application/create-user';
import { CreateUserCommand } from './create-user.command';

@CommandHandler(CreateUserCommand)
export class CreateUserService implements ICommandHandler<CreateUserCommand> {
  constructor(private readonly createUser: CreateUser) {}

  execute(command: CreateUserCommand): Promise<CreateUserResult> {
    return this.createUser.execute(
      {
        id: randomUUID(),
        eventId: randomUUID(),
        createdAt: new Date(),
        email: command.email,
        country: command.country,
        postalCode: command.postalCode,
        street: command.street,
      },
      {
        ...command.metadata,
        // Preserve profile API acceptance for arbitrary legacy requestId values.
        // The generated command identity remains a traceable, valid fallback.
        correlationId: isUserCreatedIdentity(command.metadata.correlationId)
          ? command.metadata.correlationId
          : command.id,
        causationId: command.id,
      },
    );
  }
}

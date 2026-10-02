import { Logger } from '@nestjs/common';
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

  async execute(command: CreateUserCommand): Promise<CreateUserResult> {
    const eventId = randomUUID();
    const correlationId = isUserCreatedIdentity(command.metadata.correlationId)
      ? command.metadata.correlationId
      : command.id;
    const result = await this.createUser.execute(
      {
        id: randomUUID(),
        eventId,
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
        correlationId,
        causationId: command.id,
      },
    );
    new Logger('UserCreation').log(
      result.isOk()
        ? 'User creation committed.'
        : 'User creation rejected by business rules.',
      {
        service: 'user',
        operation: result.isOk()
          ? 'user.create.committed'
          : 'user.create.rejected',
        ...(result.isOk() ? { eventId } : {}),
        correlationId,
        commandId: command.id,
      },
    );
    return result;
  }
}

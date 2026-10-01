import { createCommandContext } from '@starter/nest-support/commands';
import type { Result } from 'oxide.ts';
import type { UserAlreadyExistsError } from '../../domain/user.errors';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Command } from 'commander';
import { CommandBus } from '@nestjs/cqrs';
import { CreateUserCommand } from './create-user.command';
import type { LoggerPort } from '@starter/core/logger';
import { validateCreateUserRequest } from './create-user.request.dto';

// CLI command definition only; this example has no bootstrap or context setup.
@Injectable()
export class CreateUserCliController {
  constructor(
    private readonly commandBus: CommandBus,
    @Inject(Logger)
    private readonly logger: LoggerPort,
  ) {}

  createCommand(): Command {
    const command = new Command('new').description(
      'A command to create a user',
    );
    command
      .command('user <email> <country> <postalCode> <street>')
      .description('Create a user')
      .action(
        (email: string, country: string, postalCode: string, street: string) =>
          this.createUser(email, country, postalCode, street),
      );
    return command;
  }

  async createUser(
    email: string,
    country: string,
    postalCode: string,
    street: string,
  ): Promise<void> {
    await validateCreateUserRequest({ email, country, postalCode, street });
    const command = new CreateUserCommand({
      ...createCommandContext(),
      email,
      country,
      postalCode,
      street,
    });

    const result = await this.commandBus.execute<
      CreateUserCommand,
      Result<string, UserAlreadyExistsError>
    >(command);

    this.logger.log('User created:', result.unwrap());
  }
}

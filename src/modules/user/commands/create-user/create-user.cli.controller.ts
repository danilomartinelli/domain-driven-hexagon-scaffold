import { Inject, Injectable, Logger } from '@nestjs/common';
import { Command } from 'commander';
import { CommandBus } from '@nestjs/cqrs';
import { CreateUserCommand } from './create-user.command';
import type { LoggerPort } from '@libs/ports/logger.port';

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
    const command = new CreateUserCommand({
      email,
      country,
      postalCode,
      street,
    });

    const result = await this.commandBus.execute(command);

    this.logger.log('User created:', result.unwrap());
  }
}

import { createCommandContext } from '@starter/nest-support/commands';
import type { Result } from 'oxide.ts';
import type { UserAlreadyExistsError } from '../../domain/user.errors';
import { Controller } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { CommandBus } from '@nestjs/cqrs';
import { CreateUserCommand } from './create-user.command';
import {
  CreateUserRequestDto,
  validateCreateUserRequest,
} from './create-user.request.dto';
import { IdResponse } from '@starter/nest-support/http';

@Controller()
export class CreateUserMessageController {
  constructor(private readonly commandBus: CommandBus) {}

  @MessagePattern('user.create') // <- Subscribe to a microservice message
  async create(@Payload() message: CreateUserRequestDto): Promise<IdResponse> {
    await validateCreateUserRequest(message);
    const { email, country, street, postalCode } = message;
    const command = new CreateUserCommand({
      email,
      country,
      street,
      postalCode,
      ...createCommandContext(),
    });

    const id = await this.commandBus.execute<
      CreateUserCommand,
      Result<string, UserAlreadyExistsError>
    >(command);

    return new IdResponse(id.unwrap());
  }
}

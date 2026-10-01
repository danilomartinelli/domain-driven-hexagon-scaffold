import { RequestContextService } from '@starter/nest-support/context';
import { createCommandContext } from '@starter/nest-support/commands';
import { Args, Mutation, Resolver } from '@nestjs/graphql';
import { CommandBus } from '@nestjs/cqrs';
import { CreateUserCommand } from '../create-user.command';
import { CreateUserGqlRequestDto } from './dtos/create-user.gql-request.dto';
import { IdGqlResponse } from './dtos/id.gql-response.dto';
import type { AggregateID } from '@starter/core/domain';
import { UserAlreadyExistsError } from '../../../domain/user.errors';
import { Result } from 'oxide.ts';

// If you are Using GraphQL you'll need a Resolver instead of a Controller
@Resolver()
export class CreateUserGraphqlResolver {
  constructor(private readonly commandBus: CommandBus) {}

  @Mutation(() => IdGqlResponse)
  async create(
    @Args('input') input: CreateUserGqlRequestDto,
  ): Promise<IdGqlResponse> {
    const { email, country, street, postalCode } = input;
    const command = new CreateUserCommand({
      email,
      country,
      street,
      postalCode,
      ...createCommandContext(RequestContextService.getRequestId()),
    });

    const id: Result<AggregateID, UserAlreadyExistsError> =
      await this.commandBus.execute(command);

    return new IdGqlResponse(id.unwrap());
  }
}

import { Module } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';
import { CreateUserHttpController } from './commands/create-user/create-user.http.controller';
import { CreateUserGraphqlResolver } from './commands/create-user/graphql-example/create-user.graphql-resolver';
import { DeleteUserHttpController } from './commands/delete-user/delete-user.http-controller';
import { FindUsersGraphqlResolver } from './queries/find-users/find-users.graphql-resolver';
import { FindUsersHttpController } from './queries/find-users/find-users.http.controller';

/** User's business REST and GraphQL adapters, composed only with declared exposure. */
@Module({
  imports: [CqrsModule],
  controllers: [
    CreateUserHttpController,
    DeleteUserHttpController,
    FindUsersHttpController,
  ],
  providers: [CreateUserGraphqlResolver, FindUsersGraphqlResolver],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- Nest requires a decorated module class.
export class UserApiModule {}

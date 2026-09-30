import { Logger, Module, type Provider } from '@nestjs/common';
import { CreateUserHttpController } from './commands/create-user/create-user.http.controller';
import { DeleteUserHttpController } from './commands/delete-user/delete-user.http-controller';
import { CreateUserCliController } from './commands/create-user/create-user.cli.controller';
import { FindUsersHttpController } from './queries/find-users/find-users.http.controller';
import { CreateUserMessageController } from './commands/create-user/create-user.message.controller';
import { CreateUserGraphqlResolver } from './commands/create-user/graphql-example/create-user.graphql-resolver';
import { CreateUserService } from './commands/create-user/create-user.service';
import { DeleteUserService } from './commands/delete-user/delete-user.service';
import { FindUsersQueryHandler } from './queries/find-users/find-users.query-handler';
import { UserMapper } from './user.mapper';
import { CqrsModule } from '@nestjs/cqrs';
import { FindUsersGraphqlResolver } from './queries/find-users/find-users.graphql-resolver';
import { CreateUser } from './application/create-user';
import { DeleteUser } from './application/delete-user';
import { FindUsers } from './application/find-users';
import { SlonikUserReadAdapter } from './database/user-read.adapter';
import { SlonikUserWriteTransaction } from '@src/infrastructure/user-write-transaction';
import { WalletModule } from '../wallet/wallet.module';

const httpControllers = [
  CreateUserHttpController,
  DeleteUserHttpController,
  FindUsersHttpController,
];

const messageControllers = [CreateUserMessageController];

const cliControllers: Provider[] = [CreateUserCliController];

const graphqlResolvers: Provider[] = [
  CreateUserGraphqlResolver,
  FindUsersGraphqlResolver,
];

const commandHandlers: Provider[] = [CreateUserService, DeleteUserService];

const queryHandlers: Provider[] = [FindUsersQueryHandler];

const mappers: Provider[] = [UserMapper];

@Module({
  imports: [CqrsModule, WalletModule],
  controllers: [...httpControllers, ...messageControllers],
  providers: [
    Logger,
    SlonikUserWriteTransaction,
    {
      provide: CreateUser,
      useFactory: (transaction: SlonikUserWriteTransaction) =>
        new CreateUser(transaction),
      inject: [SlonikUserWriteTransaction],
    },
    {
      provide: DeleteUser,
      useFactory: (transaction: SlonikUserWriteTransaction) =>
        new DeleteUser(transaction),
      inject: [SlonikUserWriteTransaction],
    },
    SlonikUserReadAdapter,
    {
      provide: FindUsers,
      useFactory: (reads: SlonikUserReadAdapter) => new FindUsers(reads),
      inject: [SlonikUserReadAdapter],
    },
    ...cliControllers,
    ...graphqlResolvers,
    ...commandHandlers,
    ...queryHandlers,
    ...mappers,
  ],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- Nest requires a decorated module class.
export class UserModule {}

import { Logger, Module, type Provider } from '@nestjs/common';
import { CreateUserCliController } from './commands/create-user/create-user.cli.controller';
import { CreateUserService } from './commands/create-user/create-user.service';
import { DeleteUserService } from './commands/delete-user/delete-user.service';
import { FindUsersQueryHandler } from './queries/find-users/find-users.query-handler';
import { UserMapper } from './user.mapper';
import { CqrsModule } from '@nestjs/cqrs';
import { CreateUser } from './application/create-user';
import { DeleteUser } from './application/delete-user';
import { FindUsers } from './application/find-users';
import { SlonikUserReadAdapter } from './database/user-read.adapter';
import { SlonikUserWriteTransaction } from './database/user-write-transaction';

// Business REST/GraphQL adapters live in UserApiModule, composed with exposure.
const cliControllers: Provider[] = [CreateUserCliController];

const commandHandlers: Provider[] = [CreateUserService, DeleteUserService];

const queryHandlers: Provider[] = [FindUsersQueryHandler];

const mappers: Provider[] = [UserMapper];

@Module({
  imports: [CqrsModule],
  exports: [CreateUser],
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
    ...commandHandlers,
    ...queryHandlers,
    ...mappers,
  ],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- Nest requires a decorated module class.
export class UserModule {}

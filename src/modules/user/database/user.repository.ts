import { Inject } from '@nestjs/common';
import { DATABASE_POOL } from '@src/infrastructure/database.module';
import {
  type DatabasePool,
  type DatabaseTransactionConnection,
  sql,
} from 'slonik';
import type { UserRepositoryPort } from './user.repository.port';
import { type UserModel, userSchema } from './user.schema';
import { UserMapper } from '../user.mapper';
import { UserEntity } from '../domain/user.entity';
import { SqlRepositoryBase } from '@starter/nest-support/persistence';
import { Injectable, Logger } from '@nestjs/common';

/**
 *  Repository is used for retrieving/saving domain entities
 * */
@Injectable()
export class UserRepository
  extends SqlRepositoryBase<UserEntity, UserModel>
  implements UserRepositoryPort
{
  protected tableName = 'users';

  protected schema = userSchema;

  constructor(
    @Inject(DATABASE_POOL)
    pool: DatabasePool | DatabaseTransactionConnection,
    mapper: UserMapper,
  ) {
    super(pool, mapper, new Logger(UserRepository.name));
  }

  async updateAddress(user: UserEntity): Promise<void> {
    const address = user.getProps().address;
    const statement = sql.type(userSchema)`
    UPDATE "users" SET
    street = ${address.street}, country = ${address.country}, "postalCode" = ${address.postalCode}
    WHERE id = ${user.id}`;

    await this.writeQuery(statement, user);
  }

  async findOneByEmail(email: string): Promise<UserEntity> {
    const user = await this.pool.one(
      sql.type(userSchema)`SELECT * FROM "users" WHERE email = ${email}`,
    );

    return this.mapper.toDomain(user);
  }
}

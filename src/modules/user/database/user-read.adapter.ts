import { Inject, Injectable } from '@nestjs/common';
import { type DatabasePool, sql } from 'slonik';
import { DATABASE_POOL } from '@src/infrastructure/database.module';
import type {
  FindUsersCriteria,
  UserReadPort,
  UserSummary,
} from '../application/user-read.port';
import { userSchema } from './user.schema';

/**
 * Each returned row must be a valid stored profile, role included, before
 * only its listed fields are mapped.
 */
@Injectable()
export class SlonikUserReadAdapter implements UserReadPort {
  constructor(@Inject(DATABASE_POOL) private readonly pool: DatabasePool) {}

  async findUsers({
    country,
    postalCode,
    street,
    limit,
    offset,
  }: FindUsersCriteria): Promise<readonly UserSummary[]> {
    const rows = await this.pool.any(sql.type(userSchema)`
      SELECT id, "createdAt", "updatedAt", email, country, "postalCode", street, role
      FROM users
      WHERE
        ${country === undefined ? true : sql.fragment`country = ${country}`} AND
        ${street === undefined ? true : sql.fragment`street = ${street}`} AND
        ${
          postalCode === undefined
            ? true
            : sql.fragment`"postalCode" = ${postalCode}`
        }
      LIMIT ${limit}
      OFFSET ${offset}`);

    return rows.map((row) => ({
      id: row.id,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      email: row.email,
      country: row.country,
      postalCode: row.postalCode,
      street: row.street,
    }));
  }
}

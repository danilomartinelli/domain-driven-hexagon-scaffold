import { Inject, Injectable } from '@nestjs/common';
import { type DatabasePool, sql } from 'slonik';
import { DATABASE_POOL } from '@src/infrastructure/database.module';
import type {
  FindUsersCriteria,
  UserReadPort,
  UserSummary,
} from '../application/user-read.port';
import { userSchema } from './user.schema';

/** Rows are parsed with the stored-profile rules, limited to listed columns. */
const userSummaryRow = userSchema.omit({ role: true });

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
    const rows = await this.pool.any(sql.type(userSummaryRow)`
      SELECT id, "createdAt", "updatedAt", email, country, "postalCode", street
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

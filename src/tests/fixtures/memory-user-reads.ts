import type {
  FindUsersCriteria,
  UserReadPort,
  UserSummary,
} from '@modules/user/application/user-read.port';

/** Exact-match filters, then offset/limit over the stored order. */
export class MemoryUserReads implements UserReadPort {
  constructor(private readonly users: readonly UserSummary[]) {}

  findUsers({
    country,
    postalCode,
    street,
    limit,
    offset,
  }: FindUsersCriteria): Promise<readonly UserSummary[]> {
    return Promise.resolve(
      this.users
        .filter(
          (user) =>
            (country === undefined || user.country === country) &&
            (postalCode === undefined || user.postalCode === postalCode) &&
            (street === undefined || user.street === street),
        )
        .slice(offset, offset + limit),
    );
  }
}

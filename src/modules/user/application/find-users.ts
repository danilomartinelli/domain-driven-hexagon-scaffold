import {
  Paginated,
  type PaginatedParams,
  PaginatedQueryBase,
} from '@starter/core/domain';
import type { UserReadPort, UserSummary } from './user-read.port';

export class FindUsersQuery extends PaginatedQueryBase {
  readonly country?: string;

  readonly postalCode?: string;

  readonly street?: string;

  constructor(props: PaginatedParams<FindUsersQuery>) {
    super(props);
    this.country = props.country;
    this.postalCode = props.postalCode;
    this.street = props.street;
  }
}

export type FindUsersResult = Paginated<UserSummary>;

export class FindUsers {
  constructor(private readonly reads: UserReadPort) {}

  async execute(query: FindUsersQuery): Promise<FindUsersResult> {
    // A blank filter has always meant "any value".
    const data = await this.reads.findUsers({
      country: query.country || undefined,
      postalCode: query.postalCode || undefined,
      street: query.street || undefined,
      limit: query.limit,
      offset: query.offset,
    });
    return new Paginated({
      data,
      count: data.length,
      limit: query.limit,
      page: query.page,
    });
  }
}

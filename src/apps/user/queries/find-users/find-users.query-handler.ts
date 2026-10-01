import { type IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import {
  FindUsers,
  FindUsersQuery,
  type FindUsersResult,
} from '../../application/find-users';

@QueryHandler(FindUsersQuery)
export class FindUsersQueryHandler implements IQueryHandler<FindUsersQuery> {
  constructor(private readonly findUsers: FindUsers) {}

  execute(query: FindUsersQuery): Promise<FindUsersResult> {
    return this.findUsers.execute(query);
  }
}

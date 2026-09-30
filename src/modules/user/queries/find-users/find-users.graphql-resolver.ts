import { QueryBus } from '@nestjs/cqrs';
import { Args, Query, Resolver } from '@nestjs/graphql';
import { Result } from 'oxide.ts';
import { ResponseBase } from '@starter/nest-support/http';
import { Paginated } from '@starter/core/domain';
import type { PaginatedParams } from '@starter/core/domain';
import type { UserModel } from '../../database/user.schema';
import { UserPaginatedGraphqlResponseDto } from '../../dtos/graphql/user.paginated-gql-response.dto';
import { FindUsersQuery } from './find-users.query-handler';

@Resolver()
export class FindUsersGraphqlResolver {
  constructor(private readonly queryBus: QueryBus) {}
  @Query(() => UserPaginatedGraphqlResponseDto)
  async findUsers(
    @Args('options', { type: () => String })
    options: PaginatedParams<FindUsersQuery>,
  ): Promise<UserPaginatedGraphqlResponseDto> {
    const query = new FindUsersQuery(options);
    const result: Result<
      Paginated<UserModel>,
      Error
    > = await this.queryBus.execute(query);

    const paginated = result.unwrap();
    const response = new UserPaginatedGraphqlResponseDto({
      count: paginated.count,
      limit: paginated.limit,
      page: paginated.page,
      data: paginated.data.map((user) => {
        const base = new ResponseBase(user);
        return {
          id: base.id,
          createdAt: base.createdAt,
          updatedAt: base.updatedAt,
          email: user.email,
          country: user.country,
          street: user.street,
          postalCode: user.postalCode,
        };
      }),
    });
    return response;
  }
}

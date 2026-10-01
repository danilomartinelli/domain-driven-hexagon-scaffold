import { Field, ObjectType } from '@nestjs/graphql';
import { PaginatedGraphqlResponse } from '@starter/nest-support/graphql';

import { UserGraphqlResponseDto } from './user.graphql-response.dto';

@ObjectType()
// The base constructor initializes the decorated inherited fields.
export class UserPaginatedGraphqlResponseDto extends PaginatedGraphqlResponse(
  UserGraphqlResponseDto,
) {
  @Field(() => [UserGraphqlResponseDto])
  data!: UserGraphqlResponseDto[];
}

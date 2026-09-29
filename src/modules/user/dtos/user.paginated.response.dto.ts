import { ApiProperty } from '@nestjs/swagger';
import { PaginatedResponseDto } from '@src/libs/api/paginated.response.base';
import { UserResponseDto } from './user.response.dto';

// The base constructor initializes the decorated inherited fields.
export class UserPaginatedResponseDto extends PaginatedResponseDto<UserResponseDto> {
  @ApiProperty({ type: UserResponseDto, isArray: true })
  readonly data!: readonly UserResponseDto[];
}

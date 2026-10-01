import { ApiProperty } from '@nestjs/swagger';
import { PaginatedResponseDto } from '@starter/nest-support/http';
import { UserResponseDto } from './user.response.dto';

// The base constructor initializes the decorated inherited fields.
export class UserPaginatedResponseDto extends PaginatedResponseDto<UserResponseDto> {
  @ApiProperty({ type: UserResponseDto, isArray: true })
  readonly data!: readonly UserResponseDto[];
}

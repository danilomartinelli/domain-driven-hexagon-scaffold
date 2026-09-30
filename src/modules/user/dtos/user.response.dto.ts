import { ApiProperty } from '@nestjs/swagger';
import { ResponseBase } from '@starter/nest-support/http';

// Response mappers populate the fields; no runtime defaults are introduced.
export class UserResponseDto extends ResponseBase {
  @ApiProperty({
    example: 'joh-doe@gmail.com',
    description: "User's email address",
  })
  email!: string;

  @ApiProperty({
    example: 'France',
    description: "User's country of residence",
  })
  country!: string;

  @ApiProperty({
    example: '123456',
    description: 'Postal code',
  })
  postalCode!: string;

  @ApiProperty({
    example: 'Park Avenue',
    description: 'Street where the user is registered',
  })
  street!: string;
}

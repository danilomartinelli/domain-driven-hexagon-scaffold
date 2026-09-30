import { ApiProperty } from '@nestjs/swagger';
import { ValidationPipe } from '@nestjs/common';
import {
  IsAlphanumeric,
  IsEmail,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

// Nest/class-transformer populates these fields before validation.
export class CreateUserRequestDto {
  @ApiProperty({
    example: 'john@gmail.com',
    description: 'User email address',
    format: 'email',
    minLength: 5,
    maxLength: 320,
  })
  @MaxLength(320)
  @MinLength(5)
  @IsEmail()
  readonly email!: string;

  @ApiProperty({
    example: 'France',
    description: 'Country of residence',
    minLength: 4,
    maxLength: 50,
    pattern: '^[a-zA-Z ]*$',
  })
  @MaxLength(50)
  @MinLength(4)
  @IsString()
  @Matches(/^[a-zA-Z ]*$/)
  readonly country!: string;

  @ApiProperty({
    example: '28566',
    description: 'Postal code',
    minLength: 4,
    maxLength: 10,
    pattern: '^[a-zA-Z0-9]+$',
  })
  @MaxLength(10)
  @MinLength(4)
  @IsAlphanumeric()
  readonly postalCode!: string;

  @ApiProperty({
    example: 'Grande Rue',
    description: 'Street',
    minLength: 5,
    maxLength: 50,
    pattern: '^[a-zA-Z ]*$',
  })
  @MaxLength(50)
  @MinLength(5)
  @Matches(/^[a-zA-Z ]*$/)
  readonly street!: string;
}

/** CLI and direct message adapters do not run through the HTTP validation pipe. */
export async function validateCreateUserRequest(
  input: CreateUserRequestDto,
): Promise<void> {
  await new ValidationPipe({ transform: true, whitelist: true }).transform(
    input,
    {
      type: 'body',
      metatype: CreateUserRequestDto,
    },
  );
}

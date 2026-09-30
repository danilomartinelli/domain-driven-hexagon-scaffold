import { ApiProperty } from '@nestjs/swagger';

/** Whitelists the lookup fields; GraphQL returns the same fields. */
export class WalletResponseDto {
  constructor(props: WalletResponseDto) {
    this.id = props.id;
    this.userId = props.userId;
    this.balance = props.balance;
  }

  @ApiProperty({ example: 'cb235df6-d2af-4b75-8b6e-f9b75559392a' })
  readonly id: string;

  @ApiProperty({
    example: 'f59d0748-d455-4465-b0a8-8d8260b1c877',
    description: 'Identity of the User the Wallet belongs to',
  })
  readonly userId: string;

  @ApiProperty({ example: 0 })
  readonly balance: number;
}

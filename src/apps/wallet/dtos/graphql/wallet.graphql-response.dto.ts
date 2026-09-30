import { Field, ID, Int, ObjectType } from '@nestjs/graphql';

@ObjectType('Wallet')
// Response mappers populate the fields; no runtime defaults are introduced.
export class WalletGraphqlResponseDto {
  @Field(() => ID, { description: "Wallet's identifier" })
  id!: string;

  @Field(() => ID, {
    description: 'Identity of the User the Wallet belongs to',
  })
  userId!: string;

  @Field(() => Int)
  balance!: number;
}

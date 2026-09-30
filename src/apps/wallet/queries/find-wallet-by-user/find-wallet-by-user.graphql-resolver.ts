import { Args, ID, Query, Resolver } from '@nestjs/graphql';
import { FindWalletByUser } from '../../application/find-wallet-by-user';
import { WalletGraphqlResponseDto } from '../../dtos/graphql/wallet.graphql-response.dto';

@Resolver()
export class FindWalletByUserGraphqlResolver {
  constructor(private readonly findWalletByUser: FindWalletByUser) {}

  /** A User without a Wallet resolves to null rather than an error. */
  @Query(() => WalletGraphqlResponseDto, { nullable: true })
  async walletByUser(
    @Args('userId', { type: () => ID }) userId: string,
  ): Promise<WalletGraphqlResponseDto | null> {
    const wallet = await this.findWalletByUser.execute(userId);
    if (!wallet) return null;
    return { id: wallet.id, userId: wallet.userId, balance: wallet.balance };
  }
}

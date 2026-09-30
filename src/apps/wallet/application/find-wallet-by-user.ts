import type { WalletReadPort, WalletSummary } from './wallet-read.port';

/**
 * The application boundary REST and GraphQL share. Absence is a normal
 * result; each adapter maps it to its own representation.
 */
export class FindWalletByUser {
  constructor(private readonly reads: WalletReadPort) {}

  execute(userId: string): Promise<WalletSummary | undefined> {
    return this.reads.findByUserId(userId);
  }
}

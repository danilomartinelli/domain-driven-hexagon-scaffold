/** Lookup fields; reads never reconstruct the Wallet aggregate. */
export interface WalletSummary {
  readonly id: string;
  readonly userId: string;
  readonly balance: number;
}

export interface WalletReadPort {
  /** A User has at most one Wallet; undefined when it has not been created. */
  findByUserId(userId: string): Promise<WalletSummary | undefined>;
}

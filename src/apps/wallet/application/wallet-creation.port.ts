import type { WalletEntity } from '../domain/wallet.entity';

export interface WalletCreationEvent {
  readonly eventId: string;
  readonly userId: string;
  readonly correlationId: string;
  readonly causationId: string;
  readonly occurredAt: string;
}

export interface WalletCreationScope {
  /** Claim an event once, waiting for concurrent transactions; false means committed before. */
  claim(event: WalletCreationEvent): Promise<boolean>;
  /** Preserve any existing Wallet and balance for this User. */
  insertIfAbsent(wallet: WalletEntity): Promise<void>;
}

export interface WalletCreationTransaction {
  /** Deduplication and Wallet persistence commit together, or both roll back. */
  run<T>(operation: (scope: WalletCreationScope) => Promise<T>): Promise<T>;
}

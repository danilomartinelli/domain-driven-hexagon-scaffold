-- Up Migration

-- Wallet's own database starts from an empty baseline; no data is transferred.
CREATE TABLE "wallets" (
  "id" character varying NOT NULL,
  "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  "balance" integer NOT NULL DEFAULT 0,
  "userId" character varying NOT NULL,
  CONSTRAINT "wallets_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "wallets_userId_key" UNIQUE ("userId"),
  CONSTRAINT "wallets_balance_check" CHECK ("balance" >= 0)
);

-- The runtime role only looks Wallets up; this owner role keeps migration authority.
GRANT SELECT ON TABLE "wallets" TO "wallet_runtime";

-- Down Migration

DROP TABLE "wallets";

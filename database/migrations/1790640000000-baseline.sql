-- Up Migration

CREATE TABLE "users" (
  "id" character varying NOT NULL,
  "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  "email" character varying NOT NULL,
  "country" character varying NOT NULL,
  "postalCode" character varying NOT NULL,
  "street" character varying NOT NULL,
  "role" character varying NOT NULL,
  CONSTRAINT "UQ_e12875dfb3b1d92d7d7c5377e22" UNIQUE ("email"),
  CONSTRAINT "PK_cace4a159ff9f2512dd42373760" PRIMARY KEY ("id")
);

CREATE TABLE "wallets" (
  "id" character varying NOT NULL,
  "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  "balance" integer NOT NULL DEFAULT 0,
  "userId" character varying NOT NULL,
  CONSTRAINT "UQ_35472b1fe48b6330cd349709564" UNIQUE ("userId"),
  CONSTRAINT "PK_bec464dd8d54c39c54fd32e2334" PRIMARY KEY ("id")
);

-- Down Migration

DROP TABLE "wallets";
DROP TABLE "users";

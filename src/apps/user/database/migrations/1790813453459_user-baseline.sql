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

-- No foreign key to users: deletion never cancels a pending creation.
CREATE TABLE user_outbox (
  event_id varchar(255) PRIMARY KEY,
  envelope jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  CONSTRAINT user_outbox_identity CHECK (envelope->>'eventId' = event_id)
);
CREATE INDEX user_outbox_pending ON user_outbox (recorded_at, event_id)
  WHERE published_at IS NULL;

GRANT SELECT, INSERT, DELETE ON users TO user_runtime;
GRANT SELECT, INSERT ON user_outbox TO user_runtime;

-- Down Migration
DROP TABLE user_outbox;
DROP TABLE users;

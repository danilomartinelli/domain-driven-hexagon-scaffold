-- Up Migration

CREATE TABLE wallet_consumed_events (
  event_id character varying(255) PRIMARY KEY,
  user_id character varying(255) NOT NULL,
  correlation_id character varying(255) NOT NULL,
  causation_id character varying(255) NOT NULL,
  occurred_at TIMESTAMP WITH TIME ZONE NOT NULL,
  consumed_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT ON wallet_consumed_events TO wallet_runtime;
GRANT INSERT ON wallets TO wallet_runtime;

-- Down Migration

REVOKE INSERT ON wallets FROM wallet_runtime;
DROP TABLE wallet_consumed_events;

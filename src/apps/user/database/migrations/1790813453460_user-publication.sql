-- Up Migration
GRANT UPDATE (published_at) ON user_outbox TO user_runtime;

-- Down Migration
REVOKE UPDATE (published_at) ON user_outbox FROM user_runtime;

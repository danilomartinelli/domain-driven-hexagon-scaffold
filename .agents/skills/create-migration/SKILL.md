---
name: create-migration
description: Create and validate a SQL migration for this workspace's registered application when the user requests a schema change.
disable-model-invocation: true
---

Read [database instructions](../../../database/AGENTS.md) and the
[database workflow](../../../docs/database.md) before changing schema content.
The request supplies the schema change and, when relevant, the application.
Resolve ambiguity about data retention or rollback before writing destructive SQL.

1. Inspect the selected entry in `database/applications.ts` and the relevant
   migrations/schema. Run from the repository root after developer setup.
2. Create the file with `bun run migration:create <migration-name>`. Keep both
   `-- Up Migration` and `-- Down Migration` sections. Let `node-pg-migrate`
   manage the transaction, history and advisory lock.
3. Implement the requested change and its rollback. State explicitly if data
   restoration is impossible. Preserve the application's ownership of schema.
4. Exercise the migration through an owned disposable test environment. Use the
   prepared workflow for up/down/up checks; retain `env:exec` for every database
   command. Inspect application data/constraints, not only migration history.
   Never exercise destructive rollback against a development volume.
5. Run affected regressions and the root validation gates. Always attempt
   `env:down` for the owned test run; report migration, tests and cleanup separately.

Seeds run explicitly after migrations and are not idempotent. Repeating them on
the same data is not a recovery step. A test environment name or `NODE_ENV=test`
alone does not authorize a target. Report the migration path, observed up/down
behavior and any acceptance criteria that remain unverified.

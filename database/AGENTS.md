# Database instructions

Read [the database workflow](../docs/database.md) before changing migrations,
seeds or target selection. The registered applications are `legacy`, which
owns the shared User/Wallet schema in this directory, and `wallet`, whose
migrations and seed live in `src/apps/wallet/database/`.

## Application content

- [applications.ts](applications.ts) defines each application's environment
  prefix, migration directory, ordered seed files and optional runtime role.
  Keep this registry as the source for provisioning, migration, seeding and
  target validation. Unknown `DATABASE_APP` values must fail before connecting.
- An application with a runtime role migrates and seeds as the owner
  (`<prefix>_MIGRATION_*`); its migrations grant the runtime role only what
  the running application needs. Never run migrations with runtime credentials.
- Create SQL migrations from the repository root with
  `bun run migration:create add-user-index` (replace the example name).
  Preserve the `-- Up Migration` and `-- Down Migration` sections.
- Let `node-pg-migrate` manage `public.pgmigrations`, transactions and advisory
  locking. The baseline expects an empty database; its rollback drops the User
  and Wallet tables and their data.
- Keep seeds explicit, ordered after migrations and within one transaction.
  Current seeds are not idempotent: repeating them fails and rolls back.
  Environment preparation alone does not migrate or seed.

## Target selection

- Route database commands through [databaseTarget](target.ts). In test mode it
  validates all configured targets against the ready owned manifest before
  opening a connection. Preserve rejection of conflicting overrides and
  unregistered database targets in [environment.ts](environment.ts).
- Run test migrations and seeds through the selected `env:exec` environment;
  setting `NODE_ENV=test` or using a database name containing `test` is
  insufficient. Follow the guide's [prepared workflow](../docs/database.md#disposable-tests).

## Validation

Run from the repository root:

- `bun run test:e2e` provisions a fresh database, applies migrations and seeds,
  and runs application regressions with Docker.
- `bun run check:workspace` includes target-refusal checks without Docker.

For migration runner or environment lifecycle changes, also run
`bun run test:tooling`. These complement the root validation gates.

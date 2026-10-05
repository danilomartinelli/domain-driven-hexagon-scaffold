# Independent service distributions

From a frozen install with Bun 1.4.2, run `bun run nx run user:distribution`
or `bun run nx run wallet:distribution`. Copy the entire resulting `dist/user`
or `dist/wallet` directory to a machine with the same OS/architecture and Bun
1.4.2. No sibling source or workspace is required.

[Generated applications](library-generators.md#application-capabilities) use the
same `<name>:distribution` target. Packaging reads `app/application.json`: an
application without declared persistence receives only `start` and no database
migration interface; a persistent one additionally receives the scoped migration
tooling described below. Packaging rejects `database/` content without declared
persistence instead of silently omitting its migration configuration. Generated
app artifacts include their own README with environment and transport instructions.

Each artifact contains `app/` TypeScript, its `application.json` declaration and
owned SQL migrations, private libraries and installed transitive runtime/migration
dependencies in `node_modules/`, standalone decorator configuration, and
`distribution.json` with the installed package inventory and the database metadata
derived from the declaration (prefix, runtime role and owned migration path). `workspace.bun.lock` records the source
lock; it is provenance, not an artifact install recipe. Dependencies are already
included: do not run an install inside the artifact. Rebuild from a frozen
workspace install when changing dependencies or target platform.

## Invocation

From the artifact directory:

```sh
bun --no-env-file run migration:up
bun --no-env-file run migration:status
bun --no-env-file run start
# Roll back the most recent owned migration:
bun --no-env-file run migration:down
```

The equivalent workspace targets are `user:serve-distribution`,
`user:migration-up-distribution`, `user:migration-status-distribution` and
`user:migration-down-distribution` (replace `user` with `wallet` for Wallet).
Run them with `bun run nx run <target>` after packaging.

## Configuration

Supply settings in the process environment; no dotenv files are loaded.
Use `USER` for a User artifact and `WALLET` for a Wallet artifact:

- `<APP>_HTTP_PORT`: HTTP/GraphQL port.
- `<APP>_DB_HOST`, `<APP>_DB_PORT`, `<APP>_DB_NAME`: owned PostgreSQL database.
- `<APP>_DB_USERNAME`, `<APP>_DB_PASSWORD`: restricted runtime credentials.
- `<APP>_DB_MIGRATION_USERNAME`, `<APP>_DB_MIGRATION_PASSWORD`: owner credentials,
  supplied only to migration commands. Never supply them to the running service.
- `RABBITMQ_HOST`, `RABBITMQ_PORT`, `RABBITMQ_USERNAME`, `RABBITMQ_PASSWORD`,
  `RABBITMQ_VHOST`: required broker configuration. Broker availability does not
  gate HTTP/GraphQL startup or User creation; message delivery requires RabbitMQ.

Provision an empty owned database and its login role (`user_runtime` or
`wallet_runtime`) before migration. Migrations grant the restricted role's
permissions; only the owner can migrate. Each artifact selects its own migration
directory and credential prefix. A conflicting `DATABASE_APP` is rejected.
The database name and host are operator-supplied, so use separate owner
credentials and databases for the two services.

Packaging copies the installed dependency closure, retaining nested versions and
materializing private workspace packages. Packaging is deliberately uncached;
execution and migration targets are also uncached and always run live.

## Verification

```sh
bun run nx run user:test-distribution
bun run nx run wallet:test-distribution
bun run test:distribution
bun run nx run user:test-component
bun run nx run wallet:test-component
```

Each distribution check packages into a new directory under the system temporary
folder, outside the workspace. It provisions only the owning PostgreSQL database
and RabbitMQ, then runs the artifact's migration and startup commands with no
workspace aliases, workspace package links or sibling credentials. User REST and
GraphQL commit pending events with the broker unreachable, survive restart and
accept `user.create` without Wallet. Wallet looks up absence, consumes a fixed
`user.created` envelope and exposes the committed Wallet through both APIs.

The checks also reject a sibling migration selector and runtime migration
credentials, inspect committed database state, and clean owned resources. Both
component suites independently provision the capabilities declared by their selected app;
cross-database permission checks belong to distributed E2E. `check:full` and CI
include distribution verification; no live verification result is cached.

# User application

The independent `user` Nx application owns profile creation, listing and
deletion under `/v1/users`, plus the existing GraphQL `create` and `findUsers`
operations at `/graphql`. HTTP startup and creation require only the User
database. Wallet and RabbitMQ may be stopped.

## Run it locally

Run from the repository root with Docker available:

```sh
bun run env:prepare --environment=development --run=default
DATABASE_APP=user bun run env:exec --environment=development --run=default -- bun run migration:up
DATABASE_APP=user bun run env:exec --environment=development --run=default -- bun run seed:up
bun run env:exec --environment=development --run=default -- bun run start:user:dev
```

`start:user` runs once; `start:user:debug` adds the Bun inspector to watch mode.
The listener uses the allocated `USER_HTTP_PORT`. OpenAPI is at `/docs`.
Preparation provisions infrastructure; migrations and seeds remain explicit.
Existing development manifests gain the new database on preparation, preserving
their previous credentials and volumes. No old data is migrated or volume deleted.

```sh
bun run env:exec --environment=development --run=default -- sh -c 'curl -s "http://127.0.0.1:$USER_HTTP_PORT/v1/users"'
bun run env:exec --environment=development --run=default -- sh -c 'curl -s "http://127.0.0.1:$USER_HTTP_PORT/graphql" -H "Content-Type: application/json" -d "{\"query\":\"{ findUsers(options: \\\"\\\") { count data { id email } } }\"}"'
bun run env:down --environment=development --run=default
```

REST retains GET-body address filters and query-string pagination, response
fields, duplicate-email conflicts and deletion semantics. GraphQL retains its
required string `options` argument, which is not parsed into filters.

## Database and pending events

`USER_DB_HOST`, `USER_DB_PORT`, `USER_DB_NAME`, `USER_DB_USERNAME` and
`USER_DB_PASSWORD` select the application's database and restricted
`user_runtime` role. The app loads no dotenv files and requires broker configuration but no broker connectivity or
Wallet configuration. Database tooling alone uses `USER_DB_MIGRATION_USERNAME`
and `USER_DB_MIGRATION_PASSWORD` for migrations and seeds.

```text
REST / GraphQL / RabbitMQ -> input adapter (assign User and event identities once)
  CreateUser -> explicit UserWriteTransaction
    insert profile
    map pending fact to user.created v1 and insert its envelope in user_outbox
  commit -> success response
```

The [baseline](../src/apps/user/database/migrations/1790813453459_user-baseline.sql)
owns `users`, `user_outbox` and its migration history. The persisted envelope
contains event identity, timestamp, correlation/causation metadata and User
identity, following the [integration contract](wallet.md#user-created-integration-contract).
It contains no email or address. A supplied REST `requestId` becomes the
correlation identity when it satisfies the wire contract; otherwise the generated
command identity is used, preserving profile API acceptance. `published_at IS NULL` identifies pending work;
later publication attempts must reuse the stored envelope and identity.

There is no foreign key from outbox to profile. Deleting a profile neither
deletes nor cancels pending creation. Runtime privileges permit profile
read/insert/delete and outbox read/insert; they deny migration/schema changes,
outbox deletion and envelope mutation. The [publication migration](../src/apps/user/database/migrations/1790813453460_user-publication.sql) grants updates only to `published_at`. Neither application's effective
runtime credentials can access the other's database.

The seed creates `john@gmail.com` with identity
`a73b6bf6-6077-4117-a6b3-dff3e02f2310` and one pending creation in the same seed
transaction. This identity differs from Wallet's
direct lookup fixture. Only the pending event will create this User's Wallet;
there is no simultaneous direct Wallet insertion for it. Repeating the seed
fails and rolls back.

## Tests and migration scope

```sh
bun run nx run user:test
bun run test:user:component
# Both independent application component suites:
bun run test:component
```

The component suite provisions an isolated run, migrates/seeds User only and
starts `src/apps/user/main.ts` as an external Bun process with only its runtime
database settings. It executes the seven original Gherkin cases from
`tests/user` using independent step bindings, the characterized REST/GraphQL
contract, real PostgreSQL rollback after profile insertion, pending persistence
across restart/deletion, denied cross-database credentials and startup/creation
with sibling infrastructure stopped. Real broker tests distinguish rollback,
routing returns, confirmations lost in transit, and accepted publication whose
completion write fails. Retries retain the persisted identity. Core tests prove
transaction intent without infrastructure.

## Background publication

The publisher starts independently of HTTP/GraphQL. It declares the durable
`user.events` direct exchange and `wallet.user-created` subscription even while
Wallet is stopped. A transaction selects committed pending work with
`FOR UPDATE SKIP LOCKED`; competing User publishers cannot claim the same row
simultaneously. It sends the stored envelope with stable `messageId`, persistent
delivery and mandatory routing, then updates `published_at` only after a publisher
confirmation without a routing return. The database commit of that update is
separate from broker acceptance. Neither means Wallet has finished processing.

A return, NACK, missing confirmation, disconnect or failed completion write leaves
work pending. Uncertain success may produce duplicates; Wallet deduplicates in
its own transaction and acknowledges only after commit. Retries start at 250ms,
double to a 10s cap, and reset only after completed publication. Empty polling
waits 250ms. Connections time out after 2s; topology, confirmations and close wait
at most 5s; database connection/statement waits are bounded at 5s. Shutdown
interrupts messaging before closing the pool; restart resumes persisted work.
Deleting a profile never cancels its outbox item or removes a Wallet.

See [User commands](user-commands.md) for executable `user.create` requests and
diagnostics, and [distributed recovery](recovery.md) for broker/database evidence.
Gateway routing and independent distribution
artifacts remain later slices of [ADR 0002](adr/0002-adopt-nx-with-nest-and-bun.md#implementation-status).

# Wallet application

Wallet is the first independently runnable application of
[ADR 0002](adr/0002-adopt-nx-with-nest-and-bun.md). The Nx project `wallet`
lives in `src/apps/wallet` and looks up a persisted Wallet by User identity
through REST and GraphQL. It starts without a User process or RabbitMQ and
uses only its own database. The transitional `legacy-app` still creates Wallets
in its own database; Wallet does not read that data. The next Wallet slice
([#22](https://github.com/danilomartinelli/vibecoding-starter-js/issues/22))
activates the RabbitMQ consumer that creates Wallets from user-created events.

## Run it locally

Run from the repository root with Docker available. Preparing a development
run starts every registered database; migrations and seeds stay explicit and
select Wallet with `DATABASE_APP=wallet`:

```sh
bun run env:prepare --environment=development --run=default
DATABASE_APP=wallet bun run env:exec --environment=development --run=default -- bun run migration:up
DATABASE_APP=wallet bun run env:exec --environment=development --run=default -- bun run seed:up
bun run env:exec --environment=development --run=default -- bun run start:wallet:dev
```

`start:wallet` runs once, `start:wallet:dev` restarts on source changes and
`start:wallet:debug` adds Bun's inspector. They invoke the `wallet:serve`,
`wallet:watch` and `wallet:debug` Nx targets. The server listens on
`WALLET_HTTP_PORT`, allocated per run and logged at startup. The seed adds one
lookup example: a zero-balance Wallet for the seeded `john@gmail.com` User
identity. It is the fixture's only source; no user-created event is scheduled
for it. Seeds are not idempotent, so a second run fails and rolls back.

With the server running, look up the example from another terminal:

```sh
bun run env:exec --environment=development --run=default -- sh -c 'curl -s "http://127.0.0.1:$WALLET_HTTP_PORT/v1/wallets/by-user/f59d0748-d455-4465-b0a8-8d8260b1c877"'
bun run env:exec --environment=development --run=default -- sh -c 'curl -s "http://127.0.0.1:$WALLET_HTTP_PORT/graphql" -H "Content-Type: application/json" -d "{\"query\":\"{ walletByUser(userId: \\\"f59d0748-d455-4465-b0a8-8d8260b1c877\\\") { id userId balance } }\"}"'
```

Both return the same wallet identity, user identity and balance. A User
without a Wallet yields REST 404 and GraphQL `null`. OpenAPI is served at
`/docs`; `/graphql` has its own schema, independent of the User schema.
Wallet exposes no deposit, withdrawal, deletion or cancellation operation.

## Configuration

Wallet reads its settings from the process environment and loads no dotenv
file; `env:exec` supplies them from the selected environment manifest.

| Variable                                                                      | Meaning                                  |
| ----------------------------------------------------------------------------- | ---------------------------------------- |
| `WALLET_HTTP_PORT`                                                            | HTTP and GraphQL listener port           |
| `WALLET_DB_HOST`, `WALLET_DB_PORT`, `WALLET_DB_NAME`                          | Wallet's own database                    |
| `WALLET_DB_USERNAME`, `WALLET_DB_PASSWORD`                                    | Restricted runtime role `wallet_runtime` |
| `WALLET_DB_MIGRATION_USERNAME`, `WALLET_DB_MIGRATION_PASSWORD` (tooling only) | Owner role for migrations and seeds      |

## Database ownership

Wallet owns a new database with its own migration history and seed; no data
is transferred from the transitional database and no volume is deleted.
[Its baseline](../src/apps/wallet/database/migrations/1790801127437_wallet-baseline.sql)
creates `wallets` (one Wallet per User identity, balance never negative) and
grants the runtime role `SELECT` only. The owner role keeps migration
authority, including the `pgmigrations` history the runtime role cannot read.
Environment preparation creates the runtime role when it initializes the
cluster; see [the database workflow](database.md#application-owned-database-content).

## Read path

```text
REST GET /v1/wallets/by-user/:userId, or GraphQL walletByUser(userId: ID!)
  input adapter -> plain FindWalletByUser
    WalletReadPort.findByUserId(userId) -> WalletSummary | undefined
      Slonik adapter: runtime role, row validation, mapping
  REST maps absence to 404; GraphQL maps it to null
```

[FindWalletByUser](../src/apps/wallet/application/find-wallet-by-user.ts) and
[the Wallet read port](../src/apps/wallet/application/wallet-read.port.ts) import
nothing, and the Wallet domain imports only the plain core. The architecture
check rejects imports between applications, from the transitional `src` tree,
from production Wallet code into database tooling and from input adapters into
`database/`. Wallet has its own copy of the Wallet domain and its invariants;
the transitional application keeps its copy until the asynchronous cutover.
There is no shared User/Wallet business-model library.

## Tests

```sh
bun run nx run wallet:test            # core and read use case; part of test:unit
bun run nx run wallet:test-component  # provisioned component suite; part of test:component
```

Unit tests run the domain and `FindWalletByUser` against a small in-memory read
port, with no framework or infrastructure. The component target provisions an
isolated test run, migrates and seeds only Wallet's database, starts
`src/apps/wallet/main.ts` without User, legacy database, broker or migration
settings, and exercises both lookup APIs. It also verifies the runtime role's
privileges and that neither Wallet credential can connect to the other
configured application databases. For repeated runs against a prepared
environment:

```sh
bun run env:prepare --environment=test --run=wallet-1
DATABASE_APP=wallet bun run env:exec --environment=test --run=wallet-1 -- bun run migration:up:tests
bun run env:exec --environment=test --run=wallet-1 -- bun run nx run wallet:test-component-prepared
bun run env:down --environment=test --run=wallet-1
```

The preload validates the owned test environment before starting Wallet or
opening a connection, and cleanup revalidates before each truncation.

# Wallet application

Wallet is the first independently runnable application of
[ADR 0002](adr/0002-adopt-nx-with-nest-and-bun.md). The Nx project `wallet`
lives in `src/apps/wallet`, creates Wallets from versioned user-created RabbitMQ
events and looks them up by User identity through REST and GraphQL. Its APIs
start without a User process or an available broker and use only its own database.
The [User application](user.md) commits its integration envelope in its own
outbox and publishes it in the background after commit.

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
lookup example: a zero-balance Wallet for a standalone example User
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
Through [Kong](database.md#gateway-urls), the same REST lookup path and
`/wallet/graphql` use the environment's `GATEWAY_PROXY_PORT`.

## Configuration

Wallet reads its settings from the process environment and loads no dotenv
file; `env:exec` supplies them from the selected environment manifest.

| Variable                                                                                     | Meaning                                                                                                          |
| -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `WALLET_HTTP_PORT`                                                                           | HTTP and GraphQL listener port                                                                                   |
| `WALLET_DB_HOST`, `WALLET_DB_PORT`, `WALLET_DB_NAME`                                         | Wallet's own database                                                                                            |
| `WALLET_DB_USERNAME`, `WALLET_DB_PASSWORD`                                                   | Restricted runtime role `wallet_runtime`                                                                         |
| `WALLET_DB_MIGRATION_USERNAME`, `WALLET_DB_MIGRATION_PASSWORD` (tooling only)                | Owner role for migrations and seeds                                                                              |
| `RABBITMQ_HOST`, `RABBITMQ_PORT`, `RABBITMQ_USERNAME`, `RABBITMQ_PASSWORD`, `RABBITMQ_VHOST` | Broker supplied by the owned environment; configuration is required, connectivity is independent of HTTP startup |

## Database ownership

Wallet owns a new database with its own migration history and seed; no data
is transferred from the transitional database and no volume is deleted.
[Its baseline](../src/apps/wallet/database/migrations/1790801127437_wallet-baseline.sql)
creates `wallets` (one Wallet per User identity, balance never negative) and
initially grants the runtime role `SELECT` only. The
[consumption migration](../src/apps/wallet/database/migrations/1790807962923_wallet-consumed-events.sql)
adds `wallet_consumed_events`, grants `INSERT` on Wallets and `SELECT, INSERT`
on deduplication records. No runtime `UPDATE`, `DELETE` or schema privileges are
granted. The owner role keeps migration
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
check rejects imports between applications, from production Wallet code into database tooling and from input adapters into
`database/`. Wallet owns its domain and invariants.
There is no shared User/Wallet business-model library.

## User-created integration contract

User owns the serializable envelope exposed at
`@starter/integration-contracts/user-created`. It is a plain JSON value, not a
serialized domain-event class. The required v1 shape is:

```json
{
  "type": "user.created",
  "version": 1,
  "source": "user",
  "eventId": "4efebd63-a9d1-424d-990b-23c726cd7230",
  "occurredAt": "2026-09-30T12:00:00.000Z",
  "correlationId": "registration-42",
  "causationId": "create-user-42",
  "data": { "userId": "1f713fd5-ebcc-4954-981c-389628259a2d" }
}
```

Messages must be valid UTF-8. Identities are nonempty strings of at most 255
UTF-16 code units, with no NUL or unpaired surrogate; `occurredAt` is an ISO
timestamp in years 0001–9999, with UTC or an offset below 16 hours. These bounds
ensure accepted identities and timestamps can be persisted unchanged in meaning.
User email and address are neither required nor
included by the producer mapper. The producer assigns `eventId` once when
recording the publication, keeping it, the User identity and correlation metadata
unchanged on retries and explicit replay. Deleting a User does not invalidate
the event; Wallet never queries User to process it.

| Purpose                                 | Destination                                                                 |
| --------------------------------------- | --------------------------------------------------------------------------- |
| User integration exchange               | `user.events` (durable, direct)                                             |
| v1 routing key                          | `user.created.v1`                                                           |
| Wallet subscription                     | `wallet.user-created` (durable, manual ACK, prefetch 4)                     |
| Retained invalid/unsupported deliveries | `wallet.user-created.failed` (durable, no automatic consumer or expiration) |

These destinations are distinct from the User `user.create` **command**.
Producers must publish persistent messages with `mandatory` routing and publisher
confirmations, and declare the durable destination before publishing even when
Wallet is offline. A return, failure or missing confirmation is not acceptance.
Broker acceptance is not Wallet completion: observe lookup through REST/GraphQL.

The decoder validates the envelope and version before the use case starts.
Additive optional fields are ignored by v1 consumers. Breaking semantics require
a new supported version and explicit coexistence before retirement. Keep v1
support while retained outbox/failure messages or producers still require it;
each service evolves its own schema with expand/transition/contract migrations.
The [independent baseline fixture](../src/packages/integration-contracts/tests/fixtures/user-created-v1.json)
and consumer tests establish this compatibility baseline; they do not claim
historical release binaries have been tested.

## Delivery and recovery

```text
RabbitMQ delivery -> validate -> per-message identity/correlation metadata
  CreateWallet -> WalletCreationTransaction.run
    claim event_id (unique, durable)
    insert zero-balance Wallet if userId is absent (unique)
  commit -> ACK
```

Both writes roll back together. A concurrent duplicate waits for the unique
event claim; repeated events and different event identities for the same User
preserve the existing Wallet identity and balance. A crash after commit before
ACK causes broker redelivery and a harmless durable deduplication check.
Deduplication records are not automatically expired.

Invalid JSON, invalid envelopes and unsupported versions are published unchanged
to the failure queue as persistent messages. Original identity, correlation and
headers are retained, with failure reason, original routing and redelivery
metadata. Source expiration is removed. Only successful routing **and** publisher
confirmation permit the source ACK. Interrupted retention may leave multiple
failure copies; retaining the original identity makes future replay idempotent.
Use the [failure-queue commands](failure-queues.md) for inspection and explicit
replay through the same decoder, preserving durable ownership until confirmation.

Infrastructure errors close the connection without ACK and retry at 250ms,
500ms, 1s and so on, capped at 10s. Only successful processing resets this
backoff. Connections have a 2s timeout and heartbeat; topology and close waits
are bounded at 5s, processing at 10s, and transactional statements at 5s.
Shutdown closes consumption before the database pool, leaving interrupted work
recoverable. Messaging runs independently of HTTP/GraphQL, with explicit
per-message context and correlated commit logs, without HTTP middleware.

## Tests

```sh
bun run nx run wallet:test            # plain core/use cases/consumer; part of test:unit
bun run nx run integration-contracts:test # independent schema/fixture contracts
bun run nx run wallet:test-component  # provisioned component suite; part of test:component
```

Unit tests run the domain, read/creation use cases and consumer validation with
plain ports, without framework or infrastructure. The component target provisions
an isolated test run, migrates and seeds only Wallet's database, and starts
`src/apps/wallet/main.ts` without User, legacy database or migration settings.
It drives real RabbitMQ events and observes both APIs, proves PostgreSQL rollback
and kills a test consumer on either side of commit to observe actual broker
redelivery. Concurrent consumers preserve balances, invalid events remain in the
failure queue, and an owned TCP gate proves startup and recovery while messaging
is unavailable. The suite also verifies the runtime role's
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
opening a connection. Cleanup stops consumers and purges owned message queues
before truncating Wallet/deduplication state, preventing delayed deliveries from
racing another scenario.

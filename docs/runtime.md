# Native Bun application and tests

Use **Bun 1.4.2** from the repository root. Application TypeScript, decorators,
dependency injection metadata, path aliases and Slonik's ESM imports execute
directly, without producing `dist/`:

```sh
bun install --frozen-lockfile
make dev # or: bun run dev
```

`make dev` prepares the selected infrastructure, migrates persistent selections and
watches the selected applications; see the [database workflow](database.md#development).
Inside a prepared environment (`env:exec`),
`start` runs the selected independent application processes; `start:dev` watches them,
`start:debug` opens their Bun inspectors, and `start:prod` sets `NODE_ENV=production`.
The debug targets bind separate loopback endpoints: User uses `127.0.0.1:6499`
and Wallet uses `127.0.0.1:6500`, including when started individually. Connect to
each process's printed inspector URL; both ports must be available.
Listeners use `USER_HTTP_PORT` and `WALLET_HTTP_PORT` allocated by the selected
environment. Each exposes its own `/docs`, `/docs-json` and `/graphql`; User
REST is `/v1/users`, Wallet lookup is `/v1/wallets/by-user/:userId`.
Use `start:user` or `start:wallet` to run one service. Applications require only
their own database credentials plus broker settings; HTTP startup never waits
for broker availability. Running from source requires the workspace dependencies;
each service also has an [independent distribution](distribution.md).

The CLI controller remains a registered example without a CLI bootstrap. User's
[`user.create` command consumer](user-commands.md), Wallet's integration-event
consumer and User's outbox publisher are active. See [adapter compatibility](adapters.md).
Both applications load no dotenv file; database tooling alone reads `.env`
outside a prepared environment. See [database settings](database.md#isolation-and-configuration)
and [the Nx guide](nx-workspace.md) for environment and cache rules.

`bun run typecheck` runs TypeScript **6.0.3** with `noEmit`. Native execution is
not type checking. Type-only imports are explicit so Bun does not try to load
interfaces as runtime values, while injectable classes retain decorator metadata.
Module resolution uses `bundler`/`preserve`; alias paths are relative to the
tsconfig. `useDefineForClassFields: false` retains the existing field assignment
semantics, including inherited DTO properties initialized by base constructors.
Application, tests, database scripts and tool configurations are now checked with
strict settings. See [developer checks](developer-checks.md) for the individual
type, lint, format and architecture commands.

## Infrastructure-free core

`bun run test:unit` (also `bun run test`) runs every project's `test` target,
including `src/packages/core/tests`, the colocated package tests and each application's core
tests. Bare `bun test` discovers only `src/packages/core/tests`. Neither has a
preload, app bootstrap, dotenv loader, Nest, database or broker. These native
Bun tests cover User roles and address invariants, Wallet balances, commands,
recorded events and serializable exceptions through their public interfaces.
User creation/deletion also run against small atomic port implementations,
covering duplicate email, missing profiles and rollback when recording facts fails.
Find Users runs against a small read port implementation, covering default and
explicit pages, forwarded filters and blank filters.

Entity creation receives identity and creation time as explicit values. Commands
receive operation identity and tracing metadata from transport adapters. Domain
events contain facts; dispatch identity, correlation, causation and operation time live in
the User-owned pending integration envelope. Publication reuses that identity.
Core exceptions keep their code, cause and metadata; the exception interceptor
adds request correlation to API errors.

## Gherkin through the real application

With Docker running, provision and validate an isolated database in one command:

```sh
bun run test:e2e
```

The wrapper creates a unique Compose project with an ephemeral loopback port and
tmpfs storage for PostgreSQL and RabbitMQ, explicitly migrates/seeds, and always attempts owned-resource cleanup.
Output and exit statuses are retained under `.context/test-runs/`. See
[developer checks](developer-checks.md#isolated-database-checks) for lifecycle
limits, failure handling and the complete gate.

The wrapper runs seeds explicitly; a manual prepared workflow uses `seed:up:tests`. Tests clear users and wallets before the run and
after each case, including any seeded fixtures. The migration history is kept.
Use only a disposable validation database, never development data.

`test:e2e` invokes `test:e2e:prepared`, which explicitly selects `tests/user` and `tests/integration` and preloads
`tests/setup/preload.ts`; unit discovery never imports this setup.
The wrapper sets `NODE_ENV=test` and supplies its owned environment manifest.
For manual runs, use `env:exec` as documented in the [database workflow](database.md).
The preload validates all database targets and rejects development, sibling-run,
unknown and inactive targets **before** importing the application or opening a
pool. Cleanup revalidates before each truncation. Shell values take precedence;
an unsafe test override fails rather than redirecting the test. Bun and Nx
automatic dotenv loading remain disabled, and both loaders skip files
inside the selected environment.

`jest-cucumber` **4.5.0** receives `describe` and `test` from `bun:test`; hooks and
assertions also use Bun. The existing feature text and observable assertions
are unchanged: valid creation/listing, five invalid-input rows, and deletion.
User and Wallet run as separate Bun processes behind the owned Kong gateway, with
real Nest HTTP servers, validation, RabbitMQ and PostgreSQL. Each scenario stops
both processes, purges their queues and clears both databases before restarting
them. `afterAll` stops both processes and closes the test pools, including after
a setup failure.

```sh
bun scripts/with-test-database.ts -- bun test --preload ./tests/setup/preload.ts ./tests/user/create-user/create-user.test.ts # six cases
bun scripts/with-test-database.ts -- bun test --preload ./tests/setup/preload.ts ./tests/user/delete-user/delete-user.test.ts # one case
bun run test:e2e # seven original Gherkin cases and database/API regressions
bun run test:watch # every project's unit suite
bun run test:cov # every project's unit suite
bun run test:debug # inspector pauses before execution
```

Separate `test:e2e` invocations have independent databases. Within one suite,
shared table cleanup requires sequential cases. Migrations run explicitly in the
wrapper before the test command. For manual `test:e2e:prepared` runs, use the
[named test workflow](database.md#disposable-tests) to prepare, migrate, seed,
execute and shut down the selected environment. Run only one test process per
prepared target.

## Find Users read path

Find Users reads through an application-owned port, without reconstructing the
User aggregate:

```text
REST GET body filters + query pagination, or GraphQL options string
  adapter builds FindUsersQuery (limit 20 and page 0 by default)
    Nest CQRS handler -> plain FindUsers
      blank filters match any value; offset = page * limit
      UserReadPort.findUsers(criteria) -> UserSummary[]
        Slonik adapter: SQL, row validation, mapping
    Paginated<UserSummary>, where count is the size of this page
  adapter maps UserSummary into its existing response DTO
```

[FindUsers](../src/apps/user/application/find-users.ts) owns the plain
query, its result and the [User read port](../src/apps/user/application/user-read.port.ts),
and imports only the plain core. [SlonikUserReadAdapter](../src/apps/user/database/user-read.adapter.ts)
is the only Find Users code that executes SQL. Each returned row must satisfy
the complete stored-profile schema, including `role`, before only its listed
fields are mapped into `UserSummary`. As before, an invalid returned row fails
the listing: REST responds 500 and GraphQL reports `INTERNAL_SERVER_ERROR`.
REST and GraphQL map that read model; the architecture check rejects API and
CQRS handler imports from a module's `database/` folder.

Request and response behavior is unchanged. REST validates exact `country`,
`street` and `postalCode` filters in the GET body, and `limit`/`page` in the
query string. GraphQL `findUsers(options: String!)` still ignores its string
and returns the first 20 profiles. Results have no guaranteed order.

## Persistence and transaction review

Slonik **49.10.10**, its matching `@slonik/*` packages, Zod **4.6.5** and the
resolved `pg` **8.23.0** replace Slonik 31 and `nestjs-slonik`. The global local
`DatabaseModule` provides one awaited `createPool()` result and awaits `end()`
on application shutdown. Repositories and the User read adapter inject this
same token. The default Slonik pg driver is used; no alternate database adapter
is introduced. Slonik declares Node >=24; execution of this application is
verified on the explicitly selected Bun 1.4.2 runtime.

Queries use `sql.type(schema)` for rows, `sql.fragment` for query composition,
and `sql.unsafe` for parameterized writes without returned rows. Here `unsafe`
means untyped results, not interpolated SQL strings. The provider's async result
parser validates rows and returns parsed values, including coerced timestamps;
schemas are not merely TypeScript annotations. Mappers still validate writes.

User writes request an application-owned atomic scope:

```text
transport validates/maps input and supplies command metadata
  Nest CQRS handler -> plain CreateUser
    UserWriteTransaction.run({ users, recordUserCreated })
      insert profile + pending user.created envelope
    commit -> API success
  background publisher -> route + broker confirmation -> record published_at
  Wallet delivery -> local Wallet + deduplication transaction -> commit -> ACK
```

[CreateUser](../src/apps/user/application/create-user.ts) and
[DeleteUser](../src/apps/user/application/delete-user.ts) use the
[User write ports](../src/apps/user/application/user-write.port.ts).
[SlonikUserWriteTransaction](../src/apps/user/database/user-write-transaction.ts)
binds repositories to the User connection. No connection enters request context
or crosses into Wallet. A duplicate email retains the conflict result; missing
deletion retains the not-found result. Deletion does not cancel pending creation
or touch Wallets. See [User publication](user.md#background-publication) and
[Wallet consumption](wallet.md#delivery-and-recovery) for the separate durable
transitions and bounded retry/shutdown behavior.

The seven original Gherkin cases run against external services. System checks
cover API compatibility, eventual Wallet lookup through both APIs, service/broker
outages, User restart, profile deletion and uncertain publication. The component
suites prove local transaction rollback, database ownership, commit-before-ACK,
routing failures and missing confirmations with real infrastructure. HTTP context
remains only for request correlation and API errors. See [recovery evidence](recovery.md).

Jest's runner, transformation configs, `ts-jest`, `ts-node`, `ts-loader`, the
runtime alias hook and Nest's build toolchain have been removed. `@types/jest`
remains for jest-cucumber's runner interface. The architecture analyzer and ESLint have also been updated. `tsconfig-paths`
remains only through dependency-cruiser's resolver plugin; it is not used to
start the application or tests. The old ESLint cache dependency on `rimraf`
has been removed.

The Nest/adapters upgrade is documented in [adapter compatibility](adapters.md).
Strict lint/type settings and architecture tooling are documented in
[developer checks](developer-checks.md). The [dependency inventory](dependencies.md)
records compatible versions and security fixes. Migration progress is tracked in
[ADR 0002's implementation status](adr/0002-adopt-nx-with-nest-and-bun.md#implementation-status). CLI bootstrap remains outside the
migration scope.

References: [Slonik runtime validation](https://github.com/gajus/slonik#runtime-validation),
[jest-cucumber runner injection](https://github.com/bencompton/jest-cucumber/blob/main/docs/AdditionalConfiguration.md#configure-test-runner),
[Bun lifecycle hooks](https://bun.com/docs/test/lifecycle).

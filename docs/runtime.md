# Native Bun application and tests

Use **Bun 1.4.2** from the repository root. Application TypeScript, decorators,
dependency injection metadata, path aliases and Slonik's ESM imports execute
directly, without producing `dist/`:

```sh
bun install --frozen-lockfile
bun run env:prepare --environment=development --run=default
bun run env:exec --environment=development --run=default -- bun run migration:up
bun run env:exec --environment=development --run=default -- bun run start:dev
```

The server listens on port 3000 by default, overridable with `PORT`: REST at `/v1/users`, OpenAPI at `/docs` and
`/docs-json`, GraphQL at `/graphql`. `start:dev` uses `bun --watch` to restart
the complete application on source changes. `bun run start` runs once;
`start:debug` adds Bun's inspector; `start:prod` sets `NODE_ENV=production` and
runs the same source. Deployments need the source and runtime dependencies, not
an emitted JavaScript build. CLI and messaging controllers remain registered
examples; they still have no CLI bootstrap or messaging transport.
See [adapter compatibility](adapters.md) for the Nest/Apollo versions, CLI
command definition, and the limits of each example. The start scripts invoke Nx targets that execute the full application under Bun.
See [the Nx baseline](nx-workspace.md) for projects, commands and cache policy.

Outside a prepared environment, the shared dotenv 18 loader selects `.env.test` only when `NODE_ENV=test`,
otherwise `.env`; shell-provided values take precedence. Its new startup banner
is disabled so database status output remains readable. Bun's automatic env
loading stays disabled in `bunfig.toml`. See [database settings](database.md#isolation-and-configuration)
before using custom ports or database names. Set `PORT` to override the default
application HTTP port of 3000.

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

`bun run test:unit` (also `bun run test`) discovers `src/tests` and colocated
the `core` and `example` package tests under `src/packages`. Bare `bun test` discovers only `src/tests`. Neither has a
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
the adapter's `DomainEventPublication`, passed as the listener's second argument.
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
automatic dotenv loading remain disabled, and the shared loader skips files
inside the selected environment.

`jest-cucumber` **4.5.0** receives `describe` and `test` from `bun:test`; hooks and
assertions also use Bun. The existing feature text and observable assertions
are unchanged: valid creation/listing, five invalid-input rows, and deletion.
Nest, its HTTP server, validation, event handlers and PostgreSQL are real.
The application pool also performs cleanup; `afterAll` awaits `app.close()`,
which awaits pool shutdown. Setup failures after application creation also
close the application.

```sh
bun scripts/with-test-database.ts -- bun test --preload ./tests/setup/preload.ts ./tests/user/create-user/create-user.test.ts # six cases
bun scripts/with-test-database.ts -- bun test --preload ./tests/setup/preload.ts ./tests/user/delete-user/delete-user.test.ts # one case
bun run test:e2e # seven original Gherkin cases and database/API regressions
bun run test:watch # core only
bun run test:cov # core only
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

[FindUsers](../src/modules/user/application/find-users.ts) owns the plain
query, its result and the [User read port](../src/modules/user/application/user-read.port.ts),
and imports only the plain core. [SlonikUserReadAdapter](../src/modules/user/database/user-read.adapter.ts)
is the only Find Users code that executes SQL: it selects the listed columns,
parses rows with the stored-profile rules and maps them into `UserSummary`.
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

User writes now request an application-owned atomic scope:

```text
transport validates/maps input and supplies command metadata
  Nest CQRS handler -> plain CreateUser / DeleteUser
    UserWriteTransaction.run({ users, recordEvents })
      users.insert/delete -> persistence only
      recordEvents(facts, explicit metadata)
        transitional adapter persists Wallet on UserCreated
        adapter awaits in-process fact dispatch
    callback resolves -> Slonik commits
    callback rejects -> Slonik rolls back
```

[CreateUser](../src/modules/user/application/create-user.ts) and
[DeleteUser](../src/modules/user/application/delete-user.ts) own their input/result
models and use the [User write ports](../src/modules/user/application/user-write.port.ts).
They import only the plain core, domain and result types. Creation receives
identity/time explicitly; both operations supply correlation/causation metadata
when requesting fact recording. A duplicate email retains the existing conflict
result; missing deletion retains the not-found result.

[SlonikUserWriteTransaction](../src/infrastructure/user-write-transaction.ts)
creates repositories bound to its local connection. Connections never enter
the use cases or request context. Repository insert/delete only persist, and
neither publish nor clear facts. The application explicitly requests recording
after persistence and clears the aggregate's pending facts after that succeeds.

The adapter temporarily coordinates zero-balance Wallet creation in the same
transaction before dispatching facts with `publishDomainEvents`. It replaces
the ambient-context Wallet listener. Deletion never touches Wallets.
The adapter is the only publication authority for this write path; a failed
Wallet write or awaited dispatcher rejects the transaction. This in-process
dispatch occurs **before commit** and is neither a durable record nor an atomic
external side effect: a listener that already ran cannot be undone by PostgreSQL.
The asynchronous cutover must replace this bridge with a User-owned outbox and
post-commit publication, plus an independent Wallet consumer
([ADR 0002](adr/0002-adopt-nx-with-nest-and-bun.md)). No outbox or broker-delivery
guarantee is introduced in this slice.

HTTP/GraphQL context remains only for request correlation and API errors.
CLI and message adapters explicitly validate their request DTOs and supply command
metadata; their direct calls work without HTTP context. A CLI bootstrap and
independent broker/service startup belong to later work.

The seven original Gherkin cases remain unchanged. Real PostgreSQL regressions
cover Find Users filtering, pagination, validation and REST/GraphQL response
mapping, REST/GraphQL compatibility, Wallet write failure/recovery, persistence
without dispatch, metadata without ambient context, rollback after dispatch
failure on creation/deletion, and direct CLI/message delegation.

Jest's runner, transformation configs, `ts-jest`, `ts-node`, `ts-loader`, the
runtime alias hook and Nest's build toolchain have been removed. `@types/jest`
remains for jest-cucumber's runner interface. The architecture analyzer and ESLint have also been updated. `tsconfig-paths`
remains only through dependency-cruiser's resolver plugin; it is not used to
start the application or tests. The old ESLint cache dependency on `rimraf`
has been removed.

The Nest/adapters upgrade is documented in [adapter compatibility](adapters.md).
Strict lint/type settings and architecture tooling are documented in
[developer checks](developer-checks.md). The [dependency inventory](dependencies.md)
records compatible versions and security fixes. The remaining Nx/service separation and application-core decoupling follow
[ADR 0002](adr/0002-adopt-nx-with-nest-and-bun.md). Domain primitives are now
context-independent; command handlers and repository orchestration are still
Nest/Slonik adapters. CLI bootstrap remains outside the migration scope.

References: [Slonik runtime validation](https://github.com/gajus/slonik#runtime-validation),
[jest-cucumber runner injection](https://github.com/bencompton/jest-cucumber/blob/main/docs/AdditionalConfiguration.md#configure-test-runner),
[Bun lifecycle hooks](https://bun.com/docs/test/lifecycle).

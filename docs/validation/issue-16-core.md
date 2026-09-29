# Issue #16: context-independent domain primitives

Executed September 29, 2026 with Bun 1.4.2. This covers the bounded prefactor in
[issue #16](https://github.com/danilomartinelli/vibecoding-starter-js/issues/16),
not the complete Nx/service migration in its parent #15.

## Core and adapter responsibilities

Shared DDD, foundation helpers, exceptions, User/Wallet domain and command inputs
are plain TypeScript. Entities receive identity and creation time explicitly;
commands receive operation metadata from transport adapters. Aggregates record
facts and expose pending events without a publication method. Wallet-created
facts retain their owner identity.

`publishDomainEvents` supplies publication identity, timestamp and correlation
outside the aggregate. Repositories still invoke this adapter and await the
in-process listeners using the existing shared transaction. Exceptions serialize
without reading request state; the API interceptor supplies request correlation.
Nest handlers, ambient repository transactions and synchronous cross-module
dispatch are transitional. Application-owned transactions, independent services
and a durable outbox are later tickets.

## Executed checks

| Check                           | Result                                                                                                 |
| ------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `bun install --frozen-lockfile` | Passed; no lockfile change                                                                             |
| `bun run typecheck`             | Passed, including the original compile-time decorator fixture                                          |
| `bun run lint`                  | Passed without errors or warnings                                                                      |
| `bun run format:check`          | Passed                                                                                                 |
| `bun run deps:validate`         | Passed; 112 modules and 310 dependencies                                                               |
| `bun test`                      | 14 passed, 0 failed, 39 assertions; no preload or infrastructure                                       |
| `bun run test:e2e`              | 11 passed, 0 failed, 24 assertions: all seven original Gherkin cases plus four integration regressions |
| `bun audit`                     | No vulnerabilities across 436 checked packages                                                         |
| `bun run deps:graph`            | Regenerated with Graphviz 16.1.0                                                                       |

The native core suite also passed with `DB_PORT=1` and
`DB_NAME=not_a_test_database`, demonstrating that discovery did not import the
E2E preload (which would reject that name), database configuration or bootstrap.

The live suite used a dedicated ephemeral PostgreSQL 18.6 container named
`ddh-baghdad-issue16-test`, database `ddh_issue16_test`, a dynamic loopback port,
and tmpfs storage. The committed baseline migration was applied without seeds.
No development database or existing volume was used. The container is removed
at the end of validation.

The four integration regressions establish:

- REST creation commits a zero-balance Wallet; User deletion retains the Wallet.
- A real constraint failure during Wallet insertion rolls back both rows; the
  next request succeeds after removing the test-only constraint.
- GraphQL creation retains its response shape and persists the Wallet.
- Duplicate and invalid REST requests retain error shape and correlation IDs.

The intentional constraint failure logs a Nest/Slonik error; that is expected
inside the passing rollback test.

## Regression sensitivity

Before the change, the User creation test failed with
`Request context has not been initialized`. The command test failed the same
way even with explicit metadata, and insufficient Wallet funds failed while
constructing the domain exception. These tests now pass without context setup.

Two temporary mutations were checked and reverted:

- Removing the creation transaction made the rollback regression fail: the
  User row survived the rejected Wallet insertion.
- Re-exporting `AppRequestContext` from the shared utility barrel made
  `core-is-context-independent` fail. The closed import rule covers shared
  barrels as well as direct core-to-adapter imports.

Historical issue #5–#8 validation records describe the old default `bun test`
command. The current commands and separation are documented in
[developer checks](../developer-checks.md) and [runtime](../runtime.md).

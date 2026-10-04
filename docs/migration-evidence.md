# Migration evidence map

This map links each acceptance criterion of
[issue #15](https://github.com/danilomartinelli/vibecoding-starter-js/issues/15)
to the executable checks and policies that support it. It names suites and the
command that runs them; it does not record execution results. Pull requests and
CI runs report actual results. Update this map when an owning test moves or a
criterion's evidence changes; `check:docs` verifies every linked file and anchor.

All listed commands run in `bun run check:full` (`make check`). The fast gate
(`bun run check`) covers `check:workspace`, lint, typecheck, architecture checks
and every `test` target. `test:tooling`, `test:e2e`, `test:component` and
`test:distribution` provision real Docker infrastructure; their Nx targets are
never cached. Unless stated otherwise, paths below are test files.

## Workspace, discovery and quality workflow

**1. Frozen install and Nx discovery.** `bun install --frozen-lockfile` uses the
committed lockfile; Nx discovers both applications, shared libraries, tooling and
the E2E project.

- [Workspace guardrails](../scripts/tests/workspace.test.ts): resolved project
  edges, application independence and the [project table](nx-workspace.md#projects-and-ownership),
  affected E2E selection and copied-workspace typechecking (`check:workspace`).
- [Distribution packaging](../scripts/tests/distribution.test.ts) and the
  [generator fixture](../scripts/tests/app-generator-fixture.ts) perform frozen
  installs in scratch workspaces (`check:workspace`, `generators:test`).

**11. Generators.** `nest-app`, `ts-lib` and `nest-lib` produce usable projects;
dry runs and collisions leave existing work unchanged.

- [Library generators](../scripts/tests/library-generators.test.ts) and the
  [application generator](../scripts/tests/app-generator.test.ts) run real Nx
  generation, lint, typecheck, boundaries and Bun suites in scratch workspaces
  (`generators:test`).
- [Generated hybrid app](../scripts/tests/app-generator-live.test.ts) starts
  without a broker, recovers deliveries and drains on shutdown (`generators:test-component`).
- Policy: [local generators](library-generators.md#dry-runs-collisions-and-verification).

**12. Documentation, editor settings and commands.**

- `bun run check:docs` validates local links, anchors and that every Nx-backed
  package script appears in the [command table](nx-workspace.md#commands);
  [documentation checker tests](../scripts/tests/docs.test.ts) (`check:workspace`).
- [Workflow guardrails](../scripts/tests/workflow.test.ts) require editor tasks to
  name existing package scripts (`check:workspace`); `format:check` covers
  `.vscode/*.json`.

**20. Full local gate without empty or stale evidence.**

- [Workflow guardrails](../scripts/tests/workflow.test.ts): Makefile aliases
  delegate to package scripts, `check:full` reaches every required suite, only
  deterministic targets are cacheable, and native, component, system,
  distribution and runner suites keep their targets and test files (`check:workspace`).
- [Workspace guardrails](../scripts/tests/workspace.test.ts) prove that source,
  project tests, shared TypeScript/ESLint configuration and the decorator fixture
  invalidate cached results (`check:workspace`).
- [Regression suite discovery](../scripts/tests/regression-suite.test.ts) rejects
  incomplete or failed prepared runs (`check:workspace`).
- [Development workflow](../scripts/tests/environment.test.ts): `bun run dev`
  migrates and serves both applications through Kong, an interrupt keeps the
  infrastructure, and `dev:down` stops it with volumes retained (`test:tooling`).
- Policy: [developer checks](developer-checks.md#gates) and the
  [cache contract](nx-workspace.md#cache-contract).

## Independent applications, routing and original behavior

**2. Independent startup and Kong routing.**

- [User independence](../src/apps/user/tests/component/independence.test.ts)
  (`user:test-component`) and [Wallet user-created handling](../src/apps/wallet/tests/component/user-created.test.ts)
  (`wallet:test-component`) start each service with only its own resources.
- [API contract](../tests/integration/user-api-contract.test.ts): separate
  `/user/graphql` and `/wallet/graphql` schemas and no combined endpoint through
  Kong (`test:e2e`).
- [Environment lifecycle](../scripts/tests/environment.test.ts): owned PostgreSQL,
  RabbitMQ and DB-less Kong with routes to the selected ports (`test:tooling`).
- Policy: [gateway URLs](database.md#gateway-urls).

**3. Original Gherkin cases and the compile-time fixture.**

- [Create user](../tests/user/create-user/create-user.feature) (valid creation
  and five invalid-input rows) and [delete user](../tests/user/delete-user/delete-user.feature)
  run through Kong against separate User and Wallet processes (`test:e2e`); User's
  component suite loads the same features without Wallet (`user:test-component`).
- The [service process](../tests/setup/service-process.ts) and
  [test server](../tests/setup/test-server.ts) start external processes with
  separate databases; their fixtures are tested in `e2e:test`.
- [The decorator fixture](../src/type-tests/final.decorator.ts) is part of
  `type-fixtures:typecheck` and `user:typecheck`; its cache invalidation is
  exercised in [workspace guardrails](../scripts/tests/workspace.test.ts).

**4. Exactly one zero-balance Wallet through Kong.**

- [User/Wallet integration](../tests/integration/user-wallet.test.ts): REST and
  GraphQL creation each yield one Wallet visible through both APIs (`test:e2e`).
- [Wallet creation](../src/apps/wallet/tests/unit/create-wallet.test.ts) (`wallet:test`)
  and [Wallet lookup](../src/apps/wallet/tests/component/find-wallet-by-user.test.ts)
  (`wallet:test-component`).

## Outage recovery, idempotency and deletion policy

**5. Wallet unavailable.** [User/Wallet integration](../tests/integration/user-wallet.test.ts)
stops Wallet, creates a User and observes delivery after restart (`test:e2e`).
[Publication](../src/apps/user/tests/component/publication.test.ts) and
[user.create commands](../src/apps/user/tests/component/user-create-command.test.ts)
confirm delivery without Wallet (`user:test-component`). Policy:
[durable transitions](recovery.md#durable-transitions-and-evidence).

**6. Broker unavailable.**

- [User/Wallet integration](../tests/integration/user-wallet.test.ts): creation
  over REST and GraphQL survives User restart while RabbitMQ is stopped and is
  delivered after recovery (`test:e2e`).
- [Operations](../tests/integration/operations.test.ts): APIs stay usable and the
  persistent backlog drains with its original correlation (`test:e2e`).
- [User commands](../src/apps/user/tests/component/user-create-command.test.ts)
  (`user:test-component`) and the [User distribution](../scripts/tests/distribution-user.test.ts)
  (`test:distribution`) start without a broker.
- Policy: [broker outage and restart](recovery.md#broker-outage-and-restart).

**7. Duplicate and concurrent delivery.**

- [Wallet user-created handling](../src/apps/wallet/tests/component/user-created.test.ts):
  concurrent consumers and consumer death before or after commit leave one Wallet
  and the existing balance (`wallet:test-component`).
- [Shutdown recovery](../tests/integration/shutdown-recovery.test.ts) and
  [User/Wallet integration](../tests/integration/user-wallet.test.ts): a kill
  after Wallet commit and before ACK, and duplicate publication, keep one Wallet (`test:e2e`).

**8. Deletion retains Wallets and pending events.**

- [User/Wallet integration](../tests/integration/user-wallet.test.ts) and the
  [delete user](../tests/user/delete-user/delete-user.feature) case (`test:e2e`).
- [Outbox](../src/apps/user/tests/component/outbox.test.ts) (`user:test-component`)
  and [User use cases](../src/apps/user/tests/unit/create-user.test.ts) (`user:test`).
- Policy: [User database and pending events](user.md#database-and-pending-events).

**9. Retained failures, replay and distinguished failure paths.**

- [Wallet failures](../src/apps/wallet/tests/component/failures.test.ts) and
  [Wallet user-created handling](../src/apps/wallet/tests/component/user-created.test.ts)
  (`wallet:test-component`); [User failures](../src/apps/user/tests/component/failures.test.ts)
  and [publication recovery](../src/apps/user/tests/component/publication-recovery.test.ts)
  (`user:test-component`).
- [Failure retention](../tests/integration/failure-retention.test.ts) and
  [failure commands](../tests/integration/failure-commands.test.ts) (`test:e2e`).
- Policy: [inspect and replay](failure-queues.md#explicit-replay).

## Ownership, cores and atomicity

**10. Database ownership and environment isolation.**

- [User ownership](../src/apps/user/tests/component/database-ownership.test.ts)
  and [Wallet ownership](../src/apps/wallet/tests/component/database-ownership.test.ts)
  (`test:component`); [cross-database credentials](../tests/integration/database-ownership.test.ts)
  (`test:e2e`).
- [Environment lifecycle](../scripts/tests/environment.test.ts) and the
  [test database runner](../scripts/tests/test-database-runner.test.ts) preserve
  development and sibling resources (`test:tooling`);
  [environment guards](../scripts/tests/environment-guard.test.ts) reject unowned
  targets (`check:workspace`).
- Policy: [isolation and configuration](database.md#isolation-and-configuration).

**13. Framework-free cores and the Find Users read model.**

- User [use cases](../src/apps/user/tests/unit/create-user.test.ts),
  [Find Users](../src/apps/user/tests/unit/find-users.test.ts) and
  [commands](../src/apps/user/tests/unit/commands.test.ts) use in-memory ports
  (`user:test`); Wallet's [creation](../src/apps/wallet/tests/unit/create-wallet.test.ts)
  and [lookup](../src/apps/wallet/tests/unit/find-wallet-by-user.test.ts) do the same
  (`wallet:test`); [core errors](../src/packages/core/tests/errors.test.ts) (`core:test`).
- [Boundary regressions](../scripts/tests/boundaries.test.ts) reject framework,
  context and persistence imports into cores (`check:workspace`).
- Policy: [infrastructure-free core](runtime.md#infrastructure-free-core) and
  [Find Users read path](runtime.md#find-users-read-path).

**14. Atomicity.**

- Core intent: [User use cases](../src/apps/user/tests/unit/create-user.test.ts)
  (`user:test`) and [Wallet creation](../src/apps/wallet/tests/unit/create-wallet.test.ts)
  (`wallet:test`).
- Real adapters: [outbox](../src/apps/user/tests/component/outbox.test.ts)
  (`user:test-component`) and [Wallet transaction](../src/apps/wallet/tests/component/wallet-transaction.test.ts)
  (`wallet:test-component`); [shutdown recovery](../tests/integration/shutdown-recovery.test.ts)
  kills processes between writes (`test:e2e`).
- Policy: [persistence and transaction review](runtime.md#persistence-and-transaction-review).

**15. Architecture checks.** [Boundary regressions](../scripts/tests/boundaries.test.ts)
inject core-to-adapter, cross-app, shared-library bypass and cycle violations and
require each rule to fail (`check:workspace`); `lint:boundaries` checks the real
tree. Policy: [executable boundaries](nx-workspace.md#executable-boundaries).

## Contracts, operations and distribution

**16. Independent components and distributions.**

- Component suites provision only their service: [User independence](../src/apps/user/tests/component/independence.test.ts)
  and [Wallet user-created handling](../src/apps/wallet/tests/component/user-created.test.ts) (`test:component`).
- [User distribution](../scripts/tests/distribution-user.test.ts) and
  [Wallet distribution](../scripts/tests/distribution-wallet.test.ts) run outside
  the workspace (`test:distribution`); [packaging](../scripts/tests/distribution.test.ts)
  checks the runtime closure and owned migrations (`check:workspace`).
- [Nx runner](../scripts/tests/nx-runner.test.ts): parallel component migrations
  stay independent (`test:tooling`).
- Policy: [independent distributions](distribution.md#verification).

**17. Contract evolution.**

- [Compatibility matrix](../tests/compatibility/contracts.test.ts) (`e2e:test`)
  and [User-created envelopes](../src/packages/integration-contracts/tests/user-created.test.ts)
  (`integration-contracts:test`).
- [Retained-message transitions](../tests/integration/contract-compatibility.test.ts)
  (`e2e:test-compatibility`, included in `test:e2e`).
- Policy: [coexistence, retirement and replay](contract-evolution.md#coexistence-retirement-and-replay)
  and [service-owned schema evolution](contract-evolution.md#service-owned-schema-evolution).

**18. Readiness, diagnostics and backlog.**

- [Operations](../tests/integration/operations.test.ts) and
  [service faults](../tests/integration/service-faults.test.ts) (`test:e2e`).
- [Wallet user-created handling](../src/apps/wallet/tests/component/user-created.test.ts)
  and [User commands](../src/apps/user/tests/component/user-create-command.test.ts)
  (`test:component`).
- Policy: [operational signals](recovery.md#independent-operational-signals) and
  [correlated logs](recovery.md#correlated-logs).

**19. Shutdown and interruption.**

- [Shutdown](../tests/integration/shutdown.test.ts),
  [publication shutdown](../tests/integration/shutdown-publication.test.ts),
  [consumption shutdown](../tests/integration/shutdown-consumption.test.ts) and
  [shutdown recovery](../tests/integration/shutdown-recovery.test.ts) (`test:e2e`).
- [Generated hybrid app](../scripts/tests/app-generator-live.test.ts) drains on
  shutdown (`generators:test-component`).
- Policy: [shutdown and restart](shutdown.md#executable-evidence).

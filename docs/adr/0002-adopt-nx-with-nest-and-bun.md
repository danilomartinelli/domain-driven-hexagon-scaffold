---
status: accepted
date: 2026-09-29
---

# Adopt Nx with hexagonal Nest 12 services and native Bun

Amended on 2026-09-30: continuous integration now runs the infrastructure-free
fast gate (`bun run check`), the uncached broker regression target, distributed
end-to-end suite and service component suites on pull requests and pushes to `master`. This lifts the
GitHub Actions restriction below and the CI restriction in
[ADR 0001](0001-modernize-with-bun.md); the Docker-backed suites in
`check:full` otherwise remain local.

Amended on 2026-10-02: CI also runs the focused environment-preservation
regression for changes outside documentation. It executes the complete prepared
E2E suite while verifying development and sibling resources. The remaining
runner lifecycle cases stay in local `check:full`.

The repository will adopt Nx with `user` and `wallet` as separate Nest
applications. Wallet's current size does not determine its intended application
boundary. Preserve Nest 12 and Bun as the application runtime, package manager
and test runner, using repository-owned configuration and generators instead of
downgrading Nest to match the currently supported `@nx/nest` versions.

Shared libraries will remain internal. Organize them by useful responsibilities
rather than requiring one project per existing folder; Nest-dependent libraries
may use the repository's Nest library configuration. A private `tooling/config`
project will share ESLint, Prettier and TypeScript configuration, retaining root
entry points where tools need them.

Use a local Nx plugin with three repository-owned generators: `nest-app`,
`ts-lib` and `nest-lib`, invoked through `nx generate`. Generated projects must
include the applicable runtime, architectural boundaries and Bun test
configuration. Generating full CRUD features or use cases is outside this migration.

Retain the existing Gherkin scenarios and type-check fixture as the starting
point, adapting the E2E tests to the approved separation and consistency
contract. The earlier restriction against changing or adding E2E scenarios no
longer applies to this adaptation. The expanded scope also requires meaningful
domain, use-case, adapter and contract tests, rather than only preparing unit
configuration for future coverage. Unit-test setup must not initialize Nest,
the E2E application, PostgreSQL or RabbitMQ. Keep real infrastructure checks
separate from these tests; do not generate artificial assertions.

Quality gates will be exposed through package scripts and documented in
`AGENTS.md`. `bun run check` will run formatting, lint, type checking,
architectural dependency checks, unit tests and infrastructure-free contract
tests. `bun run check:full` will additionally prepare the test environment and
run adapter integration, service component and system E2E tests, plus independent
distribution checks.
Agents must run the full gate before declaring code changes ready; targeted
checks remain useful during development. Report projects without unit tests as
such. Do not add GitHub Actions in this migration.

Run applications locally with Bun watch mode and use Docker for infrastructure.
Provide `make dev`, `make test`, `make check` and `make down` as convenience
commands, delegating to package scripts that invoke Nx tasks. Development and
tests must use separate resources. The Makefile must not duplicate orchestration
implemented by the package scripts and Nx targets.

## Hexagonal boundaries

The migration includes removing the existing architectural coupling, not just
relocating the code. Each application's domain and application use cases will
be plain TypeScript, independent of Nest, Slonik, RabbitMQ and ambient request
or transaction context. Transport handlers, database implementations and
framework composition remain outside this core. REST, GraphQL and message
adapters invoke the same application behavior through explicit inputs.

The core owns the ports it needs and the models returned by those ports.
Queries may use dedicated read ports without reconstructing aggregates; they
must not import persistence models or execute SQL. Nest handlers delegate to
use cases, and dependency injection is wired at the application's composition
root. Technical correlation metadata enters explicitly; core entities, commands,
events and errors must be usable without an active request context.

Aggregates record domain events without publishing them. Application code
expresses atomic operations through core-owned transaction ports; database
adapters implement those operations. Saving a user and recording its integration
event must be one explicit local transaction, without Slonik connections leaking
into the core or repositories implicitly publishing events. Network publication
belongs to the outbox adapter after commit.

Use Nx project boundaries together with checks inside projects to reject core
imports of adapters, cross-app implementation imports, circular dependencies and
bypasses through shared libraries. Remove the existing request-context exception
from the domain rules. The shared DDD primitives must be plain TypeScript;
Nest-dependent libraries are reserved for adapters and composition. Generators
must preserve these boundaries without requiring an interface for every class.

Domain and use-case tests must execute with lightweight port implementations and
no infrastructure. Real adapter tests separately verify transactions, SQL,
message handling and failure recovery. These tests and automated dependency
rules are acceptance evidence for the architecture.

## Application consistency

Creating a user will succeed independently of wallet availability. Wallet
creation may complete later instead of participating in the user's PostgreSQL
transaction. This replaces the shared user/wallet transaction requirement in
[ADR 0001](0001-modernize-with-bun.md).

Wallet creation and persistence remain functional scope. The existing wallet
implementation already creates and stores wallets; it currently lacks its own
bootstrap and external API. The separate wallet application must perform that
work through the new asynchronous integration.

Use RabbitMQ as the broker between the applications. Each application will own
a separate PostgreSQL database; cross-application data access must use the
integration contract instead of reading the other application's database.
Development and E2E infrastructure must include the broker and the respective
application databases. Runtime database credentials must be technically unable
to access the other application's data; test the effective permissions and keep
migration ownership separate.

Creating a user must also succeed when RabbitMQ is unavailable, provided the
user database is available. Persist the user and its pending integration event
in one transaction using an outbox. Publish pending events in the background
with broker confirmation, durable queues and persistent messages. Wallet must
acknowledge consumption only after committing its database changes and handle
redeliveries idempotently. Invalid messages must be retained in a failure queue
for inspection and explicit reprocessing.

Version integration contracts and preserve stable message identity during retry
and replay. Contract tests must cover compatible producer/consumer evolution,
including older persisted outbox and failure-queue messages. Unsupported versions
must be retained for inspection without mutating business data. Sharing contract
schemas must not require both services to be released together.

HTTP and GraphQL startup must not wait for RabbitMQ availability. The consumer
and publisher lifecycles must recover broker connections independently, with
per-message context instead of relying on HTTP-only middleware.

Use new databases for this migration; their schemas, baselines and seeds may be
redesigned for the separate applications. Transferring data from the current
shared database is outside scope. Creating the new environments does not
require deleting existing database volumes.

Deleting a user neither deletes its wallet nor cancels a pending wallet-creation
event. A valid creation event may therefore create a wallet after its user has
been deleted. Wallet closure or cancellation is a separate functional change.

## Application adapters and gateway

All applications will support REST, GraphQL and RabbitMQ consumers, including
the scaffold produced by the application generator. User retains its existing
REST and GraphQL operations and activates its existing `user.create` message
handler. Wallet consumes user-created events to create wallets and exposes a
wallet lookup by `userId` through REST and GraphQL. This does not require CRUD
parity between the three adapters or expose deposits and withdrawals.

Use containerized Kong in DB-less mode with versioned declarative routing
configuration. Keep REST routes under `/v1/users` and `/v1/wallets`. Expose
independent GraphQL schemas at `/user/graphql` and `/wallet/graphql` through the
gateway. Schema federation is outside this migration. Kong routes HTTP traffic;
cross-application events travel through RabbitMQ.

## Independent delivery and operation

Each app must have an independently runnable distribution containing its runtime
dependencies and owned migrations, without requiring the sibling app's source,
bootstrap or release. A TypeScript artifact executed by Bun is sufficient; a
JavaScript bundle or production container image is not mandatory. Verify each
artifact in isolation and keep per-service tests independent of the other app.
The complete local quality gate may still validate the system as a whole.

Share technical helpers and explicitly versioned integration contracts, not
business entities, policies, use cases or persistence models. Each app owns its
business behavior and schema evolution. Migrations and contract changes must
allow compatible service versions to coexist; destructive changes require a
documented compatibility transition rather than a coordinated deployment.

Expose liveness and readiness separately for HTTP, the consumer and the outbox
publisher. Broker unavailability must not make otherwise usable User HTTP and
GraphQL endpoints unavailable. Shutdown must stop accepting new work, finish or
leave in-flight work recoverable, and close transports and pools safely.
Structured logs must identify the app, operation, event and correlation where
applicable. Expose pending outbox count and oldest age, retries and failures so
delivery backlog is inspectable. An external observability platform is not
required, but recovery, readiness and shutdown behavior must be tested.

## Scope

This decision defines the migration design, not an implementation or validation
record. The migration also updates the affected scripts, editor configuration,
documentation links, environment examples and architecture checks for the new
workspace layout. All identified hexagonal and microservice findings are part
of the migration's acceptance criteria, including core decoupling, tests,
independent distribution, compatibility and operational behavior. This replaces
the earlier limitation to future unit-test configuration and deferred domain
cleanup. It does not require publishing internal libraries, migrating
old data, adding GitHub Actions, introducing GraphQL federation, completing the
separate CLI example, exposing additional wallet business operations or deploying
to production.

## Implementation status

This section is the single record of migration progress; other documents link
here instead of restating it. The decision and the
[User/Wallet glossary](../../GLOSSARY.md) remain the migration contract.

Delivered slices of [issue #15](https://github.com/danilomartinelli/vibecoding-starter-js/issues/15).
#16 to #20 established the original baseline; their retained behavior now runs in the independent applications:

- #16: domain primitives without request context.
- #17: the [Nx/Bun baseline](../nx-workspace.md) around the existing regressions.
- #18: database-backed regressions in workspace-isolated environments.
- #19: User creation and deletion through plain use cases and owned ports.
- #20: Find Users through an application-owned read model.
- #21: the independent [Wallet application](../wallet.md), with its own
  database, runtime role, migration history and seed, looks Wallets up by User
  identity through REST and GraphQL.
- #22: versioned User integration envelopes, atomic Wallet creation and durable
  deduplication, RabbitMQ consumption with commit-before-ACK, retained invalid
  events and independent broker recovery. Real component tests cover crashes
  on either side of commit, concurrent delivery and API availability.

- #23: the independent [User application](../user.md), owned database/credentials,
  atomic profile and pending integration event persistence, retained events after
  deletion and external-process REST/GraphQL/Gherkin coverage without sibling services.

- #24: committed outbox publication with durable topology, mandatory persistent
  delivery, publisher confirmations, bounded recovery and stable identities.
  Independent User/Wallet processes are the default runtime and system-test
  arrangement; the shared transaction, combined bootstrap and schema are removed.
  Outage/restart/deletion and uncertain-publication checks use real broker/database
  boundaries. Scenario cleanup quiesces both processes before purging and truncating.

- #25: the independent [User command endpoint](../user-commands.md), with
  versioned validation, explicit message metadata, atomic User/outbox creation,
  correlated responses, retained failures and commit-before-ACK recovery.
  Component tests exercise the real broker/database without Wallet.

- #26: executable Nx project ownership and cycle checks plus final intra-project
  layer rules. Real command regressions reject type-only imports, shared-barrel
  bypasses, test helpers, private exports and declared project edges; command
  inputs are part of the context-independent core. The
  [validated graph](../nx-workspace.md#executable-boundaries) documents composition
  and the test-only tooling edges.

- #27: an owned [Kong DB-less gateway](../database.md#gateway-urls) renders
  versioned routes from each environment's host/ports. System tests preserve the
  original Gherkin and User API contracts through the proxy, with independent
  GraphQL schemas, eventual Wallet lookup and deletion during pending delivery.

Operator inspection and explicit replay are implemented with uncached, scoped
[User and Wallet commands](../failure-queues.md), immutable retained deliveries
and confirmed ownership transfer (#28).

[Independent distributions](../distribution.md) are implemented for User and Wallet
(#32): TypeScript, private libraries, installed dependencies, configuration and
owned migrations run outside the workspace. Component suites provision only
their service database and broker; cross-database credential checks run in the
distributed suite. Distribution execution and packaging remain uncached.

The [three local generators](../library-generators.md) now supply private core,
Nest adapter/composition libraries (#33) and independent hybrid apps (#34).
The app preset owns configuration and transport wiring without inventing persistence
or business use cases. Scratch CLI checks, isolated artifact execution and an owned
broker probe cover dry runs, collisions, metadata, recovery and bounded shutdown.
Adding persistence still requires the explicit database/environment checklist.

#35 completes the integrated developer workflow. `make dev`, `make test`,
`make check` and `make down` each delegate to one package script backed by
uncached Nx targets; `make dev` prepares development infrastructure, migrates
every registered application and watches both services. Workflow guardrails
enforce the Makefile delegation, the full gate's suites, the cache contract and
non-empty native, component, system, distribution and runner suites. The
[migration evidence map](../migration-evidence.md) links all twenty acceptance
criteria to their executable checks. This records the implementation; pull
request, merge and deployment status are tracked separately.

## References

- [Implementation specification: hexagonal User and Wallet services — issue #15](https://github.com/danilomartinelli/vibecoding-starter-js/issues/15)
- [Hexagonal architecture](https://alistair.cockburn.us/hexagonal-architecture)
- [Microservices](https://martinfowler.com/articles/microservices.html)
- [Service integration contract tests](https://microservices.io/patterns/testing/service-integration-contract-test.html)
- [Nx Nest compatibility](https://nx.dev/docs/technologies/node/nest/introduction)
- [Nx custom commands](https://nx.dev/docs/kb/run-commands-executor)
- [Nx local generators](https://nx.dev/docs/kb/local-generators)
- [RabbitMQ confirmations and acknowledgements](https://www.rabbitmq.com/docs/confirms)
- [Kong DB-less configuration](https://developer.konghq.com/gateway/db-less-mode/)

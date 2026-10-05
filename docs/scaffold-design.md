# Domain-Driven Hexagon Scaffold delivery design

Status: accepted design, approved on 2026-10-04. Identity, bounded rename and
application capabilities are implemented;
[ADR 0003's implementation status](adr/0003-application-capabilities-and-oci-delivery.md#implementation-status)
records the delivered slices and remaining work. This document records the agreed
behavior and delivery boundaries. The [adoption guide](adoption.md) describes the
shipped identity command. Other proposed commands, images and workflows below
remain accepted design.
[ADR 0003](adr/0003-application-capabilities-and-oci-delivery.md) records the
architectural trade-offs.

The implementation specification is published as
[issue #58](https://github.com/danilomartinelli/vibecoding-starter-js/issues/58),
including the confirmed testing boundaries and the `ready-for-agent` label.

## Starting point

The repository already has independent User and Wallet applications, application
and library generators, application-owned databases, durable messaging, isolated
test environments and independently runnable distributions. Current behavior is
documented in the [workspace guide](nx-workspace.md),
[generator guide](library-generators.md), [distribution guide](distribution.md)
and [recovery guide](recovery.md).

The remaining friction is configuration tied to the two example applications:
development startup, HTTP ports, gateway routes and required infrastructure.
Applications currently run on the development host, while Kong runs in Docker;
using Kong is a client convention rather than a network boundary. Application OCI
images and their publication workflow have not been implemented.

## Identity and adoption

Use **Domain-Driven Hexagon Scaffold** as the public project name and
`domain-driven-hexagon-scaffold` as the root package name. Standardize repository
license metadata on MIT, preserving upstream copyright and attribution.

Provide a small, explicit rename command with a preview. Its scope is the display
name, root package name, adopter identity and current repository references, such
as contribution contacts, ownership configuration and operational links. Preserve
the `@starter` package namespace, User/Wallet domain names, historical references
and upstream attribution. Do not rename Git branches or directories, modify Git
remotes or rename the hosted repository as a side effect.

Personalized scaffold copies, additional presets and an end-to-end CI journey
for adopting a renamed template are outside this delivery. Focused tests of the
rename command and of the new behavior remain required.

## Application capabilities

Keep one application generator/preset. Each application declares three independent
capabilities: PostgreSQL persistence, RabbitMQ messaging and exposure through Kong.
These choices describe runtime requirements, not just which files to generate.

| Capability             | Enabled                                                                                                               | Disabled                                                                                              |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| PostgreSQL persistence | Owned database, owner/runtime credentials, migration commands and applicable database readiness                       | No database provisioning, connection requirement, migration commands or database readiness dependency |
| RabbitMQ messaging     | Declared messaging adapters and required broker configuration; readiness reflects applicable consumer/publisher roles | No messaging adapters, broker connection requirement or messaging readiness dependency                |
| Kong exposure          | Business REST and GraphQL adapters reachable by clients through declared Kong routes                                  | No business REST/GraphQL adapters or Kong routes; retain private operational HTTP                     |

All eight combinations are representable, including an application with only
private operational HTTP. Disabled capabilities must not create unused services,
require unused environment variables or leave background connection attempts.
An operational skeleton does not invent business behavior or placeholder tests.

A single application declaration must drive generation, development discovery,
environment variables, ports, infrastructure, applicable migrations, distribution
contents and probes. Derived configuration must not require parallel edits to
central lists of application names. Business SQL, use cases, event contracts,
public routes and meaningful application tests remain explicit and application-owned.
Route registration comes from declared routes; generation must not expose arbitrary
handlers automatically. User and Wallet retain their existing public contracts.

## Environment topology and retained state

The reference environment is a single Linux host running Docker Compose:

- One PostgreSQL instance and persistent volume per application with persistence,
  with separate migration-owner and restricted runtime credentials.
- One shared RabbitMQ instance and vhost per environment when any application
  needs messaging. Preserve cross-application event routing and durable queues.
- One shared, DB-less Kong instance when any application exposes business APIs.
- Application containers and only the infrastructure required by their capabilities.

The same capability selection applies to development, selected application tests
and deployment configuration. Infrastructure is selected from the applications in
the requested environment; a messaging-only application must not require PostgreSQL,
and a private worker must not require Kong.

Reconcile required resources without losing existing state. Adding an application
must preserve existing credentials and volumes. Disabling a capability or removing
an application stops its use/startup without deleting databases, credentials,
volumes or queued messages. Retain resource identities independently of the active
application catalog so inspection, shutdown and later reactivation remain possible.
Existing ownership checks and isolation between sibling environments still apply.

Active consumer count is not sufficient to decide that a queue is unused: producers
can still publish while a consumer is disabled. Do not purge queues or infer that
disabling a capability cancels previously accepted work. Destructive retirement
is a separate explicit operation, outside this delivery's automatic reconciliation.

## Kong access and local development

Business REST and GraphQL access from clients always passes through Kong.
Applications run on private Docker networks without published business listeners
in both development and the reference deployment. Databases, broker management,
Kong Admin and operational listeners are not public entry points.

Development moves from host-based application processes to containers, preserving
watch and debug workflows. Any explicitly requested debugger access is local and
must not publish a business HTTP listener. Development's Kong HTTP entry point
binds to loopback. The deployed reference terminates HTTPS at Kong using
operator-supplied certificates; automated issuance and renewal are outside scope.

Health checks and isolated component tests may directly address private operational
or application listeners inside their owned environment. Distributed client tests
continue through Kong. These internal accesses do not create a client-facing bypass.

## Probes and shutdown

Reuse the existing distinction between liveness, HTTP readiness and messaging
readiness, adapting it to declared capabilities. Operational endpoints remain
private and do not expose credentials or business payloads.

- Liveness describes the running process without probing dependencies.
- HTTP readiness considers the application lifecycle and its database only when
  persistence is enabled. Broker loss must not remove otherwise usable HTTP APIs.
- Consumer and publisher readiness apply only to the messaging roles actually used.
  Disabled capabilities report that they are not applicable, not that they failed.
- A worker without business APIs still exposes private liveness and the readiness
  of its applicable capabilities. Probes must not instantiate disabled adapters.

Kong routing must use HTTP readiness rather than aggregate messaging readiness.
Container signals must reach the Bun process. Preserve the
[15-second application shutdown contract](shutdown.md); the container supervisor
must allow a longer grace period before forcing termination. Health status alone
must not imply that Docker restarts an unhealthy container or that work completed.

## OCI artifacts and publication

Use one OCI image per application for User, Wallet and generated applications.
Support `linux/amd64` and `linux/arm64`, validating execution on both architectures
and identifying whether any validation used emulation.

Reuse the independent distribution boundary. Install frozen dependencies and build
the distribution inside the target Linux environment; do not copy dependencies
installed on macOS into a Linux image. Each image carries its application's runtime
closure and any owned migration tooling, without requiring sibling source or a
workspace checkout at runtime. Do not include operator secrets or development data.

A persistent application's same image is used by its long-running server and a
separate, one-shot migration process. Commands and credentials differ; application
startup never implicitly migrates. Applications without persistence have no database
migration interface.

Provide local image builds and a manually triggered GHCR publication workflow that
selects one application or all applications. Publish public packages, matching this
public scaffold, and identify images with commit-SHA tags. Deployment configuration
uses the exact digest rather than relying on a mutable default tag. Application
images can be selected and updated independently. Publish only validated artifacts;
image publication does not automatically deploy them.

## Provisioning, secrets and migration lifecycle

Document first provisioning of the selected databases, their owners and restricted
runtime roles before application migrations. Re-running preparation must preserve
existing data and credentials; first-boot database initialization is not a substitute
for reconciliation of existing state.

Operators supply untracked secret files mounted through Compose secrets only into
the services that need them. Migration-owner credentials are available to migration
processes, while servers receive runtime credentials. The application and migration
configuration readers must support this file-based delivery without logging secrets.
Do not silently regenerate credentials when reusing an environment.

Migration commands apply only to their owning database and remain separate from
application startup. A failed migration prevents promotion of the new application
version. Preserve the existing migration locking and transactional behavior; do not
run a competing migration automatically in each application replica.

## Operating procedures

The initial reference permits a short maintenance window; it does not promise
zero-downtime updates or high availability. Deliver executable, documented procedures
for these operations:

1. Supply secrets and certificates, provision required infrastructure and database
   identities, run owned migrations, then start and verify the applications.
2. Select a new image digest, record the previous digest, inspect migration status,
   perform any required backup, migrate, update and verify applicable probes.
3. Roll back an application image only when it remains compatible with the current
   database schema and event contracts. Database reversal is an explicit separate
   operation; never automatically run migration down after a failed update.
4. Diagnose readiness, backlog and retained failures; inspect and replay messages
   using the existing identity-preserving recovery contracts.
5. Perform and verify PostgreSQL backup and restoration per application. Keep backup
   execution manual initially, without scheduling or remote-storage integration.

PostgreSQL backups do not include RabbitMQ's pending messages and are not a complete
distributed-system snapshot. Restoration procedures must state this limitation and
address retained messaging state before resuming traffic; they must not silently
purge broker state or promise an atomic system-wide rollback.

## Acceptance evidence

Implementation must provide evidence of:

- Rename preview/application without changing technical namespaces, Git metadata,
  domain names, historical references or upstream attribution.
- All eight capability combinations selecting the correct generated adapters,
  required configuration, infrastructure, migrations and probe states. Generated
  projects still need meaningful behavior/tests before satisfying application gates.
- Real persistent and messaging applications, plus disabled-capability cases that
  start without those services or credentials. Preserve User/Wallet behavior.
- Kong-only client access, absent APIs for applications without exposure, private
  probes and working containerized watch/debug flows.
- Safe addition, disablement, shutdown and reactivation with preserved development
  data, broker backlog and sibling environments.
- Independent OCI startup and separately executed owned migrations on both supported
  architectures, using distinct migration/runtime secrets and no sibling sources.
- Signal delivery and draining under containers, HTTP availability during broker
  loss, and correct readiness for unavailable enabled dependencies.
- Image selection by digest, failure handling before promotion, and verified
  operational commands including PostgreSQL restoration.

Use focused checks during implementation and the repository's full Docker-backed
gate before declaring code ready, following [developer checks](developer-checks.md).
Record local validation, remote CI, registry publication and actual deployment as
separate results. No production environment or registry publication is performed
by accepting this design.

## Delivery order

1. Standardize identity/MIT metadata and add the bounded rename command.
2. Introduce application capability declarations and adapt generation, runtime
   composition and probes while preserving the example applications' behavior.
3. Derive environment resources, routes, migrations and retained-state reconciliation
   from those declarations, removing fixed User/Wallet configuration assumptions.
4. Build independent OCI images and move development applications into private
   container networks, preserving watch/debug and isolated test workflows.
5. Add reference deployment configuration, separated migration/secret handling,
   HTTPS and the operating procedures, with executable validation.
6. Add manually triggered publication of validated images to public GHCR packages.

Each slice includes its relevant tests and documentation. These are implementation
slices, not newly created GitHub issues, commits or claims of delivery.

## References

- [Application registration checklist](adding-an-application.md)
- [Database and environment workflow](database.md)
- [Docker multi-platform builds](https://docs.docker.com/build/building/multi-platform/)
- [Compose networking](https://docs.docker.com/compose/how-tos/networking/)
- [Compose startup ordering](https://docs.docker.com/compose/how-tos/startup-order/)
- [Compose secrets](https://docs.docker.com/compose/how-tos/use-secrets/)
- [Kong certificates](https://developer.konghq.com/gateway/entities/certificate/)
- [GitHub image publication](https://docs.github.com/en/actions/tutorials/publish-packages/publish-docker-images)

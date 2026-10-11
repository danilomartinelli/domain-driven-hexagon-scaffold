# Domain-Driven Hexagon Scaffold delivery design

Status: accepted design, approved on 2026-10-04, with the transition decisions
below approved on 2026-10-06, the publication validation boundaries approved
on 2026-10-08 and the promotion runtime seam decisions approved on
2026-10-09. These decisions describe required behavior; their
approval does not establish implementation or executable verification.
[ADR 0003's implementation status](adr/0003-application-capabilities-and-oci-delivery.md#implementation-status)
records the delivered slices and remaining work. This document preserves the
agreed design and delivery boundaries. The [adoption guide](adoption.md),
[database workflow](database.md) and [distribution guide](distribution.md)
describe the shipped behavior.
[ADR 0003](adr/0003-application-capabilities-and-oci-delivery.md) records the
architectural trade-offs.

The implementation specification is published as
[issue #58](https://github.com/danilomartinelli/vibecoding-starter-js/issues/58),
including the confirmed testing boundaries and the `ready-for-agent` label.

## Starting point on 2026-10-04

At design approval, the repository already had independent User and Wallet applications, application
and library generators, application-owned databases, durable messaging, isolated
test environments and independently runnable distributions. Current behavior is
documented in the [workspace guide](nx-workspace.md),
[generator guide](library-generators.md), [distribution guide](distribution.md)
and [recovery guide](recovery.md).

The remaining friction was configuration tied to the two example applications:
development startup, HTTP ports, gateway routes and required infrastructure.
Applications ran on the development host, while Kong ran in Docker;
using Kong was a client convention rather than a network boundary. Application OCI
images and their publication workflow had not been implemented.

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

### Changing an existing application's capabilities

The declaration selects runtime requirements from a compatible application-owned
composition. Enabling a capability that the application has never implemented
requires the author to prepare that integration. Changing a boolean does not
generate handlers, invent business behavior or rewrite application-owned code.
Validate the compatibility before changing the environment.

Disabling and later reactivating an existing integration must preserve its source
and durable state. While disabled, it contributes no adapter instances, required
credentials, connection attempts, applicable migrations or readiness dependency.
An empty generated application must support this transition and retain private
operational HTTP. Keeping source for later reactivation must not impose the
disabled integration's runtime requirements.

If registered business functionality still requires a disabled capability, reject
the configuration before changing the environment and identify the incompatible
dependency. The author explicitly defines the functionality available in each
supported combination. Do not silently remove a business route or substitute a
different behavior to make the combination start; preserve User/Wallet contracts.
This restriction does not change the deliberate withdrawal of business adapters
when exposure itself is disabled.

Application-owned functionality groups declare their required capabilities
explicitly at the composition boundary. The same registrations drive application
composition and its preflight compatibility check. For example, a registered User
creation group that requires persistence makes a declaration with persistence
disabled invalid. The error identifies the group and its unmet requirement.
Requirements belong with composition; domain entities and use cases remain
framework-free.

Validate registered groups before bootstrapping database or messaging adapters and
before changing the environment. The selected artifact must expose the information
needed for this check without requiring a source checkout or live database/broker.
Explicit requirements do not by themselves prove correct wiring or behavior:
executable tests must exercise supported combinations and rejected configurations
through the real composition and public tooling boundaries.

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

### Deployment configuration and reconciliation

`deployment.json` represents the desired application selection, exact image
digests and ingress configuration throughout the installation's lifetime. It is
not limited to the original bootstrap selection. Image-update commands must keep
that desired configuration coherent with their requested changes.

Keep three distinct concepts:

- **Desired configuration:** the operator's requested applications, images and
  ingress. An edit alone does not establish that the environment changed.
- **Applied state:** the recorded outcome of operations against the installation,
  including the results for individual applications. A desired digest is not
  proof that its migration, startup or verification succeeded.
- **Retained resources:** the owned identities and durable resources preserved
  after an application or capability becomes inactive. Their management does not
  depend on their continued presence in the desired selection.

Changing the desired configuration must not prevent inspection or shutdown of the
existing installation. Those actions use its recorded state and retained resource
identities, while preserving all ownership checks.

Plan topology changes without changing the running environment. Show the services
to add or stop, resources to retain, applicable migrations and expected maintenance
interruptions. Applying that plan is a separate explicit operation, rather than an
implicit consequence of repeating preparation. Applying a plan can coordinate required
provisioning, separately executed owning migrations and startup, validating the
conditions before promoting each image. Server startup still never migrates.

If a change involves several applications and a later step fails, retain confirmed
progress, record each application's result and stop further promotions. Preserve
resources and allow an explicit continuation from the recorded progress. Keep the
failed application in its documented safe state; do not automatically return all
images to previous versions or reverse database changes. Image rollback still
requires schema and event-contract compatibility. No transaction across
applications, databases and the broker is promised.

These decisions were approved on 2026-10-06 to close the existing runtime and
deployment transition gaps. The composition preflight contract above and the
post-migration outcomes below complete the approved behavioral decisions for
these gaps. Implementation and executable verification remain separate work.

### Verification failure after a successful migration

Record the candidate image, completed migration outcome and actual process/readiness
state separately from successful transition completion. Selecting a digest or
committing its schema changes does not prove that the application was verified.

If HTTP is ready but an applicable messaging role is not, keep the candidate
running and retain Kong access to its otherwise usable HTTP operations. Record
that the candidate is running with messaging degradation and verification pending;
do not report the transition as successfully completed or promote further
applications. Existing messaging recovery may continue. Explicit continuation
rechecks readiness and records recovery without repeating completed migrations.

If the process or HTTP readiness fails to become ready by the verification
deadline, stop the candidate using the existing bounded shutdown contract. Record
the failure and retain the migrated database and other owned resources. Recovery
requires explicit continuation or image rollback after evaluating schema and
event-contract compatibility; neither automatically reverses the database. This
candidate-verification policy does not replace ordinary running applications'
dependency-outage recovery behavior.

### Promotion runtime seam

The following architecture and testing decisions were approved on 2026-10-09.
They define a refactoring of promotion and verification that preserves existing
operator behavior. Approval does not establish implementation or executable
verification. [ADR 0004](adr/0004-promotion-runtime-seam.md) records the trade-offs.
The self-contained implementation specification is published as
[issue #89](https://github.com/danilomartinelli/domain-driven-hexagon-scaffold/issues/89).

- **Semantic operations:** introduce a runtime interface for installation actions
  and observations, such as starting a candidate, querying migrations and observing
  readiness. The Docker adapter owns command arguments, subprocess execution and
  response interpretation. A test adapter represents the effects in memory.
  Injecting only an arbitrary command executor would preserve the tests'
  dependency on Docker command syntax.
- **First scope:** apply the seam to per-application promotion and candidate
  verification, shared by reviewed topology application, update, rollback and
  continuation. Extracting every installation operation is outside this first
  scope; it would also bring in restoration, replay and resource retirement.
- **Durable records:** orchestration continues to interpret and write installation
  and transition records. The runtime performs actions and returns observations;
  it does not infer runtime success from those records. In tests, the in-memory
  adapter owns independent simulated runtime state while orchestration uses real
  records in a temporary directory. Tests assert the resulting records without
  using them to manufacture observations of running resources.
- **Injectable clock:** inject the verification clock instead of patching global
  time in tests. Preserve the existing 60-second polling window, check order and
  individual command timeouts. The window begins after startup and gateway
  refresh; an observation already in progress can finish after the window, and
  readiness is checked before expiration. This is not a 60-second limit for the
  entire verification. Durable timestamps continue to represent real date and
  time. A strict end-to-end deadline is a separate behavioral change.
- **Partial effects and interruption:** an action result and the observed resource
  state are separate facts. The test adapter must support failure before or after
  an effect, unavailable observations and interruption; a failed start command
  does not prove that no candidate is running. Promotion retains the decision
  about verification and recovery from those facts. Preserve the existing
  interruption outcome and pending records without introducing automatic
  candidate shutdown on interruption.
- **Test migration:** exercise the production promotion module in process with
  the semantic runtime adapter and real temporary records. Reconstruct the
  operation from those files to prove continuation across invocations. Move the
  promotion and verification decision matrices into the unit and light gates,
  retaining the light gate's hard 180-second execution limit. Keep full-command
  tests for arguments, preflight, rollback review, desired selection, deployment
  record linkage, exit codes, locks and real subprocess signals. Retain focused
  Docker adapter coverage for migrations, readiness, recovery, ownership and
  resource preservation. Replace migrated Docker-fake cases rather than
  duplicating them; cases that still prove full-command contracts remain.

Acceptance must demonstrate a start command failing after its candidate exists,
unknown readiness remaining unverified, interruption retaining recoverable
progress, and continuation reconstructed from disk without repeating completed
migrations. Manual-clock tests must cover the existing polling expiration and an
observation finishing after it. These fast tests establish orchestration behavior;
CLI and real Docker tests establish their respective integration contracts.

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

### Publication validation boundaries

The common publication gate establishes technical readiness of the selected
immutable artifact. Application-owned tests establish business behavior. These
boundaries were approved on 2026-10-08 after an audit reproduced rejection of a
healthy image with a custom Kong route and approval of an image whose enabled
messaging consumer remained disconnected. The
[implementation status](adr/0003-application-capabilities-and-oci-delivery.md#implementation-status)
records the delivered validator and its executable checks.

For HTTP exposure, validate private HTTP readiness and the effective technical
routing configuration in Kong against the application's declaration. Do not
invent a business endpoint, HTTP method, authentication scheme, GraphQL query or
request payload. A route can require authentication or change durable state;
generic readiness cannot assume that a business request is safe or should return 200. Functional requests and their expected responses remain in application-owned
tests. This correction does not require a new per-application functional scenario
interface as a condition of publication.

The refinement approved on 2026-10-09 discovers optional distribution scenarios
from each selected application's `test-distribution` Nx target, after artifact
approval. Preparation and the full image suite supply the same approved platform
image ID and platform. Targets are responsible for executing that image; this is
a documented contract, not a new enforced interface. Missing targets are logged
and continue with approval alone; failing scenarios prevent the approval receipt.
User and Wallet include their isolated image shutdown cases in their own targets.

Read back the installed Kong services and routes and compare their effective
configuration with the declaration. For each declared application upstream,
also establish that Kong actually reached the artifact's private HTTP readiness
endpoint. In the gate-owned disposable Kong, mark the target unhealthy, observe
`UNHEALTHY`, and require automatic recovery to `HEALTHY` through an active probe
of the same target/address. Keep active checks enabled for unhealthy targets and
passive checks disabled; no configuration reload or manual healthy mutation may
occur between observations. A successful mutation response or an initially
healthy target is insufficient evidence. This proof shares the single readiness
deadline below and never changes health in an existing development or deployment
environment.

The controlled transition is required because
[Kong 3.9.1 initializes new targets as healthy](https://github.com/Kong/kong/blob/3.9.1/kong/runloop/balancer/healthcheckers.lua#L43-L60).
It proves connectivity through Kong's active HTTP probe; it does not execute
business route matching, authentication or functional responses. The installed
route configuration and application-owned scenarios provide their respective
evidence. This gateway proof was approved on 2026-10-08; public preparation regressions verify the
transition against the actual DB-less Kong fixture.

Respect the declared exposure capability independently of retained route source.
Disabled exposure requires no Kong route or business request. Enabled exposure
without declared routes does not invent an API. A successful technical check
does not claim to have exercised every route's authentication or business logic.

For messaging, every applicable consumer or publisher role must be ready before
the artifact receives publication approval. Both roles need not exist, and a
disabled role is not applicable rather than failed. HTTP readiness alone cannot
approve an artifact whose enabled messaging remains unavailable. Application-owned
tests continue to establish message exchange, recovery, and identity preservation;
the common gate must not invent a universal business message or handler.

Validate the readiness response against the selected application and its enabled
capabilities, rather than accepting HTTP 200 alone. With messaging enabled, at
least one messaging role must be applicable and every applicable role must be
ready; with messaging disabled, both roles must be not applicable. Missing,
malformed, unknown, or mismatched responses never establish readiness.

After the artifact process starts, use one shared window of at most 60 seconds
to establish its complete technical readiness. All applicable checks share that
deadline; a new retry or a different dependency does not restart the clock.
Transient startup and reconnection can recover within the window. If readiness
is still incomplete at the deadline, fail validation without an approval receipt
and preserve diagnostics identifying the unmet conditions. The existing bounded
cleanup still runs; the readiness deadline does not waive resource ownership or
shutdown guarantees. This waiting policy was approved on 2026-10-08.

This is a publication approval condition, separate from ordinary process startup.
Preserve HTTP availability during broker outages and existing distribution tests
that deliberately start an application while its broker is unavailable. A shared
startup helper must not implicitly impose full messaging readiness on those paths.

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
- Existing generated integrations surviving enabled-to-disabled-to-enabled
  transitions without requiring disabled services or credentials. Incompatible
  business composition must fail before changing the environment, with the
  dependency identified rather than its behavior silently omitted.
- Functionality-group requirements driving both composition and preflight. Reject
  an unmet requirement before adapter bootstrap or environment changes; also
  execute the real supported compositions rather than treating metadata as proof.
- Real persistent and messaging applications, plus disabled-capability cases that
  start without those services or credentials. Preserve User/Wallet behavior.
- Kong-only client access, absent APIs for applications without exposure, private
  probes and working containerized watch/debug flows.
- Safe addition, disablement, shutdown and reactivation with preserved development
  data, broker backlog and sibling environments.
- Independent OCI startup and separately executed owned migrations on both supported
  architectures, using distinct migration/runtime secrets and no sibling sources.
- Public publication preparation accepting valid custom and REST-only routing
  without a presumed GraphQL endpoint or business request, including authenticated
  and state-changing routes. Disabled exposure and empty route declarations must
  not invent an API. Installed routes must match the effective declaration.
- Actual Kong target recovery through an active readiness probe, within the shared
  deadline. Initial optimistic health, a successful health mutation without an
  observed transition, or unreachable private HTTP must not produce approval.
- Publication preparation accepting consumer-only, publisher-only and combined
  messaging roles when all applicable roles are ready, and refusing an otherwise
  HTTP-ready image whose applicable role remains unavailable. Disabled messaging
  requires neither role; enabled messaging cannot report both as not applicable.
- Transient startup or reconnection recovering within the single 60-second window,
  and permanent degradation exhausting it without an approval receipt. Retries
  must not reset the deadline; malformed, unknown or mismatched readiness responses
  cannot count as success. Failure retains diagnostics and bounded cleanup.
- Application-owned functional API and message scenarios still using the selected
  immutable artifact, including the existing broker-outage HTTP behavior.
- Signal delivery and draining under containers, HTTP availability during broker
  loss, and correct readiness for unavailable enabled dependencies.
- Image selection by digest, failure handling before promotion, and verified
  operational commands including PostgreSQL restoration.
- Deployment planning without changing the running environment, explicit
  application of selection changes and usable inspection/shutdown after desired
  configuration edits. Verify retained resources, recorded partial progress and
  explicit continuation after a later application's failure.
- Successful migrations followed by candidate verification failure: messaging-only
  degradation keeps usable HTTP available without reporting a completed transition;
  process/HTTP failure past the deadline stops the candidate and retains the
  migrated state. Verify explicit continuation, completed migrations not repeated,
  and no automatic image or database rollback.

Use focused checks during implementation and the repository's light pre-commit
gate before declaring code ready; the full Docker-backed gate runs on demand,
following [developer checks](developer-checks.md).
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

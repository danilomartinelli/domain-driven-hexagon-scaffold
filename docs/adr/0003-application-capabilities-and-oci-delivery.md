---
status: accepted
date: 2026-10-04
---

# Configure application capabilities and deliver independent OCI images

Domain-Driven Hexagon Scaffold will retain one application generator with independent
choices for PostgreSQL persistence, RabbitMQ messaging and Kong exposure, deriving
runtime and environment requirements from those choices. Applications will run in
private container networks in development and the single-host Compose reference,
with client REST/GraphQL access through Kong and private operational probes.
Each application will have an independent Linux amd64/arm64 OCI image, reused by a
separate migration process when persistence is enabled, and explicitly published
to GHCR without automatic deployment. The [accepted delivery design](../scaffold-design.md)
defines the behavior and acceptance evidence; the
[implementation status](#implementation-status) records delivered slices.

This revises [ADR 0002](0002-adopt-nx-with-nest-and-bun.md)'s mandatory adapter set
and host-based development topology. It extends its independent distribution
contract with OCI images; the migration's historical implementation record remains
valid. Framework-free application cores, application-owned data and contracts,
independent operation and identity-preserving recovery remain required.

## Consequences

- Keeping a single generator with capabilities avoids separate presets that drift,
  but requires validation of every capability combination and conditional probes.
- Containers make Kong-only client access an enforceable deployment boundary at the
  cost of adapting local watch, debugging and test orchestration.
- PostgreSQL stays isolated per persistent application, while RabbitMQ and Kong are
  shared only within the selected environment. Disabling capabilities preserves
  resource identity and durable state rather than deleting them.
- Reusing an application's image for migrations keeps code and SQL aligned; distinct
  commands and secret mounts separate migration privileges from runtime privileges.
- The initial reference allows maintenance windows and manual operational steps.
  Image rollback requires schema/contract compatibility and never implies automatic
  database reversal or an atomic rollback of the distributed system.

## Transition decisions approved on 2026-10-06

An existing application's declaration selects a compatible composition prepared
by its author. A capability flag does not generate missing integration code or
silently remove business functionality that still depends on that capability.
Reject incompatible combinations before changing the environment. Disabling and
reactivating an existing integration must retain its source and durable resources
without imposing disabled runtime dependencies. This preserves application
ownership while making capability changes effective beyond initial generation.
Application-owned functionality groups declare capability requirements in the
same registrations used for composition and preflight validation. This makes
compatibility explicit without deriving business requirements from framework
bootstrap side effects; real execution tests still establish the behavior.

Deployment configuration is the desired selection throughout an installation's
lifetime, with applied state and retained resources recorded separately. Updating
the desired selection cannot strand inspection or shutdown. Plan topology changes
without changing the running environment, then apply them explicitly; that
operation may coordinate provisioning, separate owning migrations and startup.
This replaces the fixed-bootstrap restriction for the required deployment
reconciliation behavior.

Retain confirmed progress if a later application's transition fails, record its
result, stop further promotions and allow explicit continuation. Do not simulate
an atomic deployment by automatically returning every image or reversing durable
state; rollback retains its schema and event-contract compatibility requirements.

After successful migration, a candidate with ready HTTP and unavailable messaging
keeps running and serving usable HTTP, with verification pending and further
promotions stopped. Explicit continuation verifies recovery without repeating
completed migrations. If the process or HTTP fails verification past its deadline,
stop the candidate with the existing bounded shutdown contract and retain migrated
state for explicit recovery or compatibility-reviewed image rollback. This
distinguishes candidate verification from ordinary dependency-outage recovery and
does not equate an applied schema or selected image with a verified transition.

The [delivery design](../scaffold-design.md#deployment-configuration-and-reconciliation)
records the seven approved decisions and their acceptance evidence. These are
accepted design clarifications, not a claim that the transition gaps are fixed.

## Implementation status

The identity and MIT metadata standardization and bounded rename command from
[issue #59](https://github.com/danilomartinelli/vibecoding-starter-js/issues/59)
are implemented; see the [adoption guide](../adoption.md).

Fresh application generation and capability-aware probes are implemented (#60).
Each application declares its name and independent `persistence`, `messaging` and
`exposure` choices in
`src/apps/<name>/application.json`, parsed by the private `@starter/capabilities`
package. The single `nest-app` generator emits all eight combinations, with
configuration readers, adapters and dependencies for the enabled capabilities
only, explicit registration lists and no generated business behavior or tests.
Composition composes business REST/GraphQL adapters only with declared exposure
and passes the declaration to the shared readiness probes: liveness is
independent of dependencies, HTTP readiness considers the database only with
persistence, messaging readiness applies to the roles in use and disabled
capabilities report `not_applicable`. Database tooling, distribution migration
interfaces, failure-queue commands and the required-suite guardrail discover
applications from their declarations instead of a central name list. User and
Wallet declare all three capabilities and keep their contracts. A live matrix
generates, checks and executes every combination against real PostgreSQL and
RabbitMQ, with absent and never-contacted dependencies for disabled capabilities.
Prepared generated integrations support declaration-only disablement and
reactivation (#72). Selected factories defer adapter loading; distribution inputs
follow the declaration, omitting inactive adapters and migration interfaces while
retaining owned source and SQL in the checkout. Separate transition regressions
exercise public development commands with retained data and broker work and
independent Linux artifacts. See the [author workflow](../application-compatibility.md#disable-and-reactivate-prepared-integrations).

Functionality-group requirements and preflight compatibility validation are
implemented (#71); see the [author/operator contract](../application-compatibility.md).
Application-owned registrations drive composition and reject missing capabilities
before adapter construction or environment mutation. Independent artifacts carry
the same contract, and operators validate selected images in isolation before
changing the installation. Source, artifact and live environment/operator tests
verify rejection and preservation of existing state. The full local Docker gate
and remote CI passed for this implementation; registry publication and deployment
remain separate.

Selected development and test environments derive startup, infrastructure, ports,
configuration and explicit Kong routes from declarations (#61). Development
reconciliation preserves credentials, owned volumes and queued work across
addition, disablement, removal and reactivation; retained resources stay
inspectable and stoppable. The public generator/environment matrix and retained
User-to-Wallet delivery regression exercise these operations with real services.

Independent OCI images and private application containers are implemented (#62).
The target Linux environment installs the frozen dependency tree and packages the
existing distribution. Application startup and owned migration commands use the
same image with separate credentials. Development watches bound source with Bun
as PID 1, exposes business routes only through loopback Kong, and opens a loopback
inspector only when requested. Kong actively probes HTTP readiness; container
healthchecks describe liveness and do not restart unhealthy containers. Docker
allows 20 seconds for the existing 15-second application shutdown contract.
Local image execution covers ARM64 natively and AMD64 through emulation; see
[distribution verification](../distribution.md#linux-oci-images).

Manual GHCR publication tooling is implemented (#64): discovered one/all
selection, exact-image execution and transfer on both architectures, public
package preflight, commit tags and immutable digest output. See
[publication](../publication.md) for setup and the explicit trigger. Actual
registry publication and package visibility remain unverified until an
authorized dispatch executes.

The [Compose reference operations](../operations.md) are implemented (#63):
independent image digests, file secrets, private services and HTTPS, separated
owner migrations, verified updates/rollback and manual per-application recovery.
Desired-deployment planning is implemented (#73); see
[operations](../operations.md#desired-applied-and-retained-state). `deployment.json`
remains the desired selection, while `state.json` records applied images with
separate migration and startup outcomes and the retained owned identities. Planning
previews services, retained resources, applicable migrations and interruptions
without changing the installation. Inspection and shutdown use the applied
inventory after desired edits, and version 1 inventories are adopted with their
identities. Image updates keep the desired selection coherent. Applying topology
changes remains to be implemented; the updater still rejects changed
capabilities/routes.
Candidate verification failures currently leave the selected candidate in its
reached process state; the explicit degraded-verification state and bounded stop
on process/HTTP verification failure described above are not yet implemented.

No actual registry publication or deployment is established by this ADR.

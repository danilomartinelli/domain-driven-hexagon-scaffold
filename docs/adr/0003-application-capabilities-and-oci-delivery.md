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

## Implementation status

The identity and MIT metadata standardization and bounded rename command from
[issue #59](https://github.com/danilomartinelli/vibecoding-starter-js/issues/59)
are implemented; see the [adoption guide](../adoption.md).

Application capabilities are implemented (#60). Each application declares its
name and independent `persistence`, `messaging` and `exposure` choices in
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

Pending: the Compose reference operations (#63). No actual registry publication
or deployment is established by this ADR.

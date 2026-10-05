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
defines the behavior and acceptance evidence; implementation is pending.

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
are implemented; see the [adoption guide](../adoption.md). The remaining
[issue #58](https://github.com/danilomartinelli/vibecoding-starter-js/issues/58)
capability, container topology, OCI, publication and operating-procedure work
is pending. No registry publication or deployment is established by this ADR.

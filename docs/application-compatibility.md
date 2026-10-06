# Application compatibility before provisioning

`application.json` selects capabilities. The author-owned `composition.json`
registers the integrations the application has prepared and the functionality
groups its composition binds. Changing a selection never generates application
code, creates handlers or substitutes business behavior.

```json
{
  "integrations": ["persistence", "messaging", "exposure"],
  "groups": [
    { "name": "orders", "requires": ["persistence", "messaging"] },
    { "name": "orders-api", "requires": ["persistence"], "exposure": true }
  ]
}
```

At the composition boundary, pass these registrations to
`composeApplication` from `@starter/capabilities/composition`, together with
factories keyed by the same integration and group names. The generated
`composition/app.module.ts` provides this structure. Each functionality factory
returns Nest module metadata (`imports`, `providers`, `controllers`); generated
messaging applications also accept `handlers`, the injection tokens of registered
message handlers. Domain entities and use cases keep their plain TypeScript ports.

The complete selection and factory binding are checked before any factory runs.
An enabled capability without a prepared integration fails with an instruction to
implement and register it. A group with an unmet requirement fails with its name
and missing capability. Groups are never silently removed because their required
dependency is disabled. Only groups explicitly marked `exposure: true` are
withdrawn when exposure is disabled. Put business resolvers and exposure-only
providers in such a group; private operational HTTP remains available.

User registers profile persistence, durable delivery (persistence and messaging),
and its exposed API. Wallet registers durable creation (persistence and messaging)
and exposed lookup. Disabling persistence or messaging therefore rejects their
existing business composition, including when exposure is disabled. Broker
unavailability remains different from disabling messaging: their HTTP services
still start and pending work retains the existing recovery behavior.

Generated applications have an empty group list and no invented business
functionality. When adding behavior, add its requirement registration and factory
together, then exercise the real public behavior. Registrations express a contract;
they cannot prove that an author correctly implemented a database or message
adapter. Startup additionally rejects missing or extra factory bindings.

## Source and delivered commands

Run source preflight without credentials, a database or a broker:

```sh
bun --no-env-file src/packages/capabilities/preflight.ts src/apps/user
```

Generation validates its output selection before writing it. Application startup,
selected environment preparation/development, image builds, distribution packaging
and selected migration/seed targets validate before constructing adapters or
mutating their environment. Environment inspection and shutdown continue to use
retained inventory, so an incompatible source edit does not strand resources.

Every independent distribution carries `application.json`, `composition.json`,
the runtime factories and the same preflight implementation:

```sh
cd dist/user
bun run preflight
```

Preflight prints the compatible declaration as JSON, or exits nonzero with a
compatibility diagnostic. It does not read dependency credentials. A distribution
needs neither a source checkout nor a sibling application for this command.

For an immutable image, the operator runs its packaged preflight with no network,
a read-only filesystem, no mounted secrets and no application environment. New
preparation validates every selected image before provisioning. Update/rollback
validates the candidate before rewriting Compose or applied state, stopping a
service or migrating. Existing prepare/start/migrate/replay/restore operations
also validate their selected artifacts. Failure preserves existing services,
credentials, databases and queued work; diagnostic logs may be written and Docker
may fetch the selected image. Old images without the compatibility contract fail
closed and must be rebuilt with their application-owned registrations.

This check does not plan topology transitions or establish schema/event-contract
compatibility for rollback. Those remain separate operator contracts in
[operations](operations.md).

## Executable evidence

The distribution and generator suites execute real source and delivered startup,
including TCP sentinels proving rejected configurations do not contact dependencies.
The selection suite rejects incompatible Wallet changes while retaining existing
inventory and durable work. The operations suite selects a deliberately
incompatible immutable image and verifies rejected preparation/update without
changes to services, credentials, state, database rows, outbox or queues. Existing
component, distribution and end-to-end suites retain User/Wallet API and delivery
coverage. Run the focused suites and full gate in [developer checks](developer-checks.md).

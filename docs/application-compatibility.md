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

At the composition boundary, import `composeApplicationModule` from
`@starter/nest-support/composition` and call it with the application directory and
`{ integrations, groups }` factories. It reads the
application declaration and registrations once, checks compatibility and the exact
factory binding through the framework-free `composeApplication`, then awaits the
selected integrations followed by functionality groups. Factories may be synchronous
or asynchronous and return Nest metadata (`imports`, `providers`, `controllers`).
The generated `composition/app.module.ts` exports this dynamic module directly;
User and Wallet import it into their own module, which retains their HTTP conventions.

The persistence integration must return `database: { inject, useFactory }`, whose
factory supplies an asynchronous database probe. This is required by its type and
checked again during composition. User and Wallet query their owned tables to prove
schema and runtime grants; the generated probe checks connectivity. Other parts
cannot register a database probe. A part can register `consumer` and `publisher`
provider tokens, and a `backlog: { inject, useFactory }` returning an asynchronous
source of pending count and oldest age. Roles structurally supply `start()`,
`stop()` and `snapshot()`; nest-support imports no RabbitMQ adapter.

Composition rejects duplicate roles, messaging without a role (or a role without
messaging) and a backlog without a publisher before any provider is instantiated.
These are plain author errors; packaged preflight continues checking selections
without loading Nest or factories. Register roles in the same part as their
providers. Their readiness always comes from those instances; composition starts
them in registration order and drains them in parallel, idempotently on close.

Groups may declare `handlers`, the injection tokens of their message handlers.
The shared `MESSAGE_HANDLERS` token supplies their instances to the consumer even
though the messaging integration is composed before those groups. Handler types
remain application-owned. The module mounts health endpoints and exports only
`ApplicationReadiness` for injectable, read-only `snapshot()` access; probes,
construction and lifecycle state are internal. Bootstrap calls `installShutdown(app)`
from `@starter/nest-support/operations` with no callback. Domain entities and use
cases keep their plain TypeScript ports.

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

## Disable and reactivate prepared integrations

For an empty generated application whose integrations were prepared at generation,
edit only its `application.json` selection, then run preflight and prepare the same
development environment again:

```sh
bun --no-env-file src/packages/capabilities/preflight.ts src/apps/telemetry
bun run env:prepare --environment=development --run=telemetry --app=telemetry
bun run dev --run=telemetry --app=telemetry
```

Stop the current application process before changing its selection. Disable
`persistence`, `messaging` or `exposure` independently; leave `composition.json`,
adapter source and owned SQL intact. Disabled integrations load no adapter, read
no dependency credentials and contribute no readiness dependency. Private health
HTTP remains available. Restoring the flag and preparing the same run reuses its
resource identities, credentials, database rows and accepted broker work. Missing
consumers do not cancel messages. Shutdown preserves retained volumes; sibling
environments remain independently owned.

Keep functionality requirements accurate: an incompatible group is rejected
before environment changes, rather than removed. A capability generated as absent
still requires the author to implement and register it before enabling it. For an
older generated application with eager imports, move optional adapter imports into
selected factories as in the current template and declare its capability-specific
[distribution inputs](distribution.md). No command rewrites existing author code.

Rebuild `<name>:distribution` or the independent Linux image after selection
changes. Nonpersistent artifacts have no migration interface or owned migration
files even though SQL remains in the checkout. Reactivating persistence restores
the interface on the next build. A Compose installation applies such images
through a [reviewed topology plan](operations.md#apply-a-reviewed-plan); this
contract does not apply a production deployment.

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
also validate their selected artifacts, and `plan`/`apply` validate every desired image. Failure preserves existing services,
credentials, databases and queued work; diagnostic logs may be written and Docker
may fetch the selected image. Old images without the compatibility contract fail
closed and must be rebuilt with their application-owned registrations.

[Planning](operations.md#plan-desired-changes) uses this inspection to explain
rejected desired selections before any change. The check neither applies topology
transitions nor establishes schema/event-contract compatibility, which rollback
reviews separately.

## Executable evidence

The nest-support in-process composition tests exercise health responses, rejected
compositions, handler injection and role start/stop through the public entry in
`test:unit` and the light gate. The distribution and generator suites execute real source and delivered startup,
including TCP sentinels proving rejected configurations do not contact dependencies.
The selection suite rejects incompatible Wallet changes while retaining existing
inventory and durable work. The operations suite selects a deliberately
incompatible immutable image and verifies rejected preparation/update without
changes to services, credentials, state, database rows, outbox or queues. Existing
component, distribution and end-to-end suites retain User/Wallet API and delivery
coverage. Run the focused suites, and the on-demand full gate when complete local
evidence is wanted, as described in [developer checks](developer-checks.md).

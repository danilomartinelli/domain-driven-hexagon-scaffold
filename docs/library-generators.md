# Local Nx generators

The local `@starter/generators` Nx plugin supplies `nest-app`, `ts-lib` and `nest-lib`.
Run commands from the repository root after the [setup checks](developer-checks.md#setup).
Use a unique lowercase kebab-case name. Libraries go under `src/packages/<name>`,
with an explicit `@starter/<name>` public export. Applications go under
`src/apps/<name>` and export no implementation.

```sh
bun run nx generate @starter/generators:ts-lib text-normalization --dry-run
bun run nx generate @starter/generators:ts-lib text-normalization
bun run nx generate @starter/generators:nest-lib text-adapter
```

| Preset                         | Layer         | Responsibility                                      |
| ------------------------------ | ------------- | --------------------------------------------------- |
| `ts-lib`                       | `core`        | Framework-free shared technical behavior            |
| `nest-lib` (default)           | `adapter`     | Nest-facing technical adapters; no generated module |
| `nest-lib --layer=composition` | `composition` | Register and export an existing injectable provider |
| `nest-app` (`--preset=hybrid`) | application   | Selected persistence, messaging and exposure        |

Business entities, use cases and persistence models remain application-owned.
The Nest library preset rejects `--layer=core`. Composition requires both `--provider`
and `--providerImport`, pointing to a real class exported by a private workspace
package. For example, after implementing and exporting `TextAdapter` from
`@starter/text-adapter`:

```sh
bun run nx generate @starter/generators:nest-lib text-composition \
  --layer=composition \
  --provider=TextAdapter \
  --providerImport=@starter/text-adapter
```

This creates `TextCompositionModule` with that provider in `providers` and
`exports`; it does not invent providers or their constructor dependencies.
Supply providers whose dependencies are already available, and extend the
composition when more wiring is needed. Private subfolder imports and
undeclared package entry points are rejected. Before writing files, the generator
checks that the selected entry point exports the provider as a runtime value,
following reexports and aliases without executing provider code. Missing names
and type-only exports are rejected. No empty module is generated.

## Generated libraries and consumption

Each library has a private package manifest, `project.json`, `tsconfig.json`,
`bunfig.toml`, `index.ts` and usage/test documentation. The Nx tags are
`scope:shared` and `type:core`, `type:adapter` or `type:composition`.
Implement useful behavior behind the public interface in private subfolders;
the generator creates no CRUD, use case or artificial assertion.

Generation formats its files and runs Bun installation after Nx commits the
virtual tree, updating the lockfile and local workspace links. Repeat the
[setup checks](developer-checks.md#setup) after these dependency changes.
Declare `"@starter/<name>": "workspace:*"` in each consumer's dependencies
(the root manifest for applications), then run `bun install` again. Import
through the declared entry point, never through a package's private folders.

```sh
bun run nx show project text-normalization --json
bun run nx run text-normalization:lint
bun run nx run text-normalization:typecheck
bun run nx run text-normalization:test
bun run lint:boundaries
```

The native Bun `test` and `test-watch` targets use only that library's `tests/`
directory, without infrastructure or preload. **No tests exist initially**:
Bun reports that absence and exits nonzero. Add meaningful tests through public
exports alongside real behavior before considering the library ready. Lint
and type targets reuse the strict repository configuration.

The file-level boundary rules recognize every package tagged `type:core`, as
well as the original core. Both direct Nest imports and indirect escapes
through adapters are rejected. App domain/application code may consume these
framework-free cores. Nx additionally checks ownership, declared dependencies
and cycles. Tests retain the repository's public-entry-point restrictions.
Declared public exports may be unconsumed while a library is being developed;
the orphan check still rejects unexported, unused files.

## Dry runs, collisions and verification

`--dry-run` previews file changes without writing the destination, installing
packages or changing the lockfile. Existing destinations and duplicate project
names fail before writes. Paths, nested packages and invalid presets are rejected.

```sh
bun run nx run generators:test
```

The uncached [generator suite](../scripts/tests/library-generators.test.ts) uses
an isolated scratch copy and its own installed dependencies and Nx cache. It
generates both kinds and a provider composition, consumes their public exports,
checks discovery, formatting, lint, types, native Bun behavior and architecture,
and proves both legal core consumption and rejected framework/adapter imports.
It also verifies dry runs, collisions and absent-test reporting. Cleanup removes
only that run's temporary directory in `finally`; it never provisions Docker
or copies development environment files. The suite runs in `test:unit`,
`check`, `check:full` and CI through the plugin's `test` target.

## Application capabilities

```sh
bun run nx generate @starter/generators:nest-app telemetry --dry-run
bun run nx generate @starter/generators:nest-app telemetry \
  --persistence=false --messaging=true --exposure=true
bun run nx generate @starter/generators:nest-app ledger --persistence --no-messaging --no-exposure
bun run nx show project telemetry --json
bun run nx run telemetry:lint
bun run nx run telemetry:typecheck
bun run lint:boundaries
TELEMETRY_HTTP_PORT=3010 TELEMETRY_RABBITMQ_URL=amqp://localhost:5672 \
  bun run nx run telemetry:serve
```

`hybrid` remains the only app preset; three independent boolean options select
its capabilities, so all eight combinations come from the same generator:

| Option          | Default | Enabled                                                                             | Disabled                                                    |
| --------------- | ------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `--persistence` | `false` | Runtime pool, `<PREFIX>_DB_*` settings, migration interface and database readiness  | No database settings, pool, migrations or readiness         |
| `--messaging`   | `true`  | Recovering RabbitMQ consumer, `<PREFIX>_RABBITMQ_*` settings and consumer readiness | No broker settings, adapters, connections or readiness      |
| `--exposure`    | `true`  | GraphQL module and explicit business REST/GraphQL registration lists                | No business REST/GraphQL adapters; operational HTTP remains |

The defaults keep the previous hybrid capabilities, messaging and exposure; the
output now adds `application.json` and registers message handlers by injection
token. The generator writes the choice
to `application.json`, the application's single declaration, and emits only the
configuration readers, adapters, package dependencies and documentation of the
enabled capabilities. Disabled means absent: no settings are required and nothing
connects in the background. It uses the installed Nest 12 and Bun 1.4.2 directly,
without an upstream Nest preset. Output for all capabilities includes:

```text
src/apps/telemetry/
  application.json            # name and the three capabilities
  composition.json            # prepared integrations and functionality requirements
  main.ts                     # bootstrap and shared bounded shutdown
  configs/environment.ts      # TELEMETRY_* readers of enabled capabilities only
  composition/app.module.ts   # registered factories and readiness probes
  database/                   # persistence: runtime pool module and migrations/README.md
  application/message-handler.ts  # messaging: plain handler port and explicit identity
  adapters/                   # messaging transport and exposure's GraphQL status
  tests/unit/                 # infrastructure-free native tests
  tests/component/            # separately selected live tests
```

The private manifest has `exports: {}` and the project has `scope:telemetry` and
`type:app` tags. No application becomes a shared library. Composition reads
`application.json` and passes it to the shared readiness probes, which reject a
declaration that does not match the supplied database and messaging probes.
Business REST/GraphQL adapters, including the GraphQL module, are composed only
while the declaration enables exposure.
Liveness never probes dependencies. HTTP readiness considers the lifecycle and,
only with persistence, the database. Consumer readiness applies only with messaging;
the publisher role, backlog and disabled capabilities report `not_applicable`.
See [probe semantics](recovery.md#independent-operational-signals).

Composition binds the functionality groups registered in `composition.json` to
factories in `functionality`. Factories return module metadata and, with messaging,
handler injection tokens. The generated group list and factory map start empty;
add requirements and bindings together as behavior is introduced. The shared
[compatibility check](application-compatibility.md) rejects unmet requirements
before adapters or environment changes, including from an independent image.
Nothing is exposed or consumed automatically. Exposure keeps an operational
GraphQL `{ httpReady }` query so the schema is valid; client routes are configured
separately in the gateway. Without exposure, `/graphql` does not exist.

With messaging, HTTP health endpoints work with the broker down; RabbitMQ
reconnects with bounded exponential delay. Invalid or unsupported envelopes are
confirmed into `<queue>.failed` before acknowledgement, preserving available
identity, content metadata, headers and an `x-failure-reason`. Handlers return a
permanent `{ accepted: false, reason }` rejection or throw for a transient retry.
Timed-out operations remain tracked until they settle, before this instance
reconnects or finishes draining. Use atomic idempotency for redelivery across
instances. Message identity is passed explicitly and GraphQL/DI metadata is
declared for Bun. The generator supplies no business rules, CRUD, SQL, event
contracts, public routes or tests.

Only `TELEMETRY_HTTP_PORT` is always required. Messaging requires
`TELEMETRY_RABBITMQ_URL`; `TELEMETRY_RABBITMQ_QUEUE` defaults to
`telemetry.commands.v1`, so select unique queues per environment. Persistence
requires `TELEMETRY_DB_HOST`, `_PORT`, `_NAME`, `_USERNAME` and `_PASSWORD` for the
restricted `telemetry_runtime` role; the pool connects lazily and startup never
migrates. Use `telemetry:watch` and `telemetry:debug` for development.
SIGINT/SIGTERM refuses new work, drains accepted requests and deliveries and
closes messaging before Nest closes HTTP and the pool, with a 15-second deadline.

The app's `test`, `test-watch`, `test-coverage` and `test-debug` targets select only
`tests/unit/`; `test-component` is uncached and selects only `tests/component/`.
No preload starts infrastructure implicitly. Both directories initially contain
instructions, not placeholder assertions, and test commands exit nonzero until
tests exist. Live fixtures must own and validate every resource they clean up.

```sh
bun run nx run telemetry:distribution
# Copy dist/telemetry to the deployment directory, then from that directory:
TELEMETRY_HTTP_PORT=3010 TELEMETRY_RABBITMQ_URL=amqp://localhost:5672 bun run start
```

Distribution carries the installed dependency closure and the declaration, and
executes without the workspace or sibling sources. A persistent declaration makes
the app a database application without editing a registry: workspace commands
accept `DATABASE_APP=<name>` and the artifact adds owned `migration:*` commands.
Add SQL under `database/migrations/` as described in
[application-owned database content](database.md#application-owned-database-content).
Disabled persistence keeps owned SQL in the checkout but omits migrations and
their interface from the artifact. Prepared environments also provision, migrate
and validate its database like any persistent application. Environment HTTP ports,
root startup selection and applicable broker
settings derive from the declaration. Kong routes remain application-owned and
explicit in `application.json`; follow the [application checklist](adding-an-application.md).

The [app generator tests](../scripts/tests/app-generator.test.ts) exercise the CLI,
dry-run/collision guarantees, project checks and a distribution after deleting its
scratch workspace. The [live probe](../scripts/tests/app-generator-live.test.ts)
adds only test-owned behavior and proves startup with a blocked broker, HTTP/GraphQL,
explicit message identity, recovery, retained invalid input and normal draining
shutdown. The [capability matrix](../scripts/tests/app-capabilities-live.test.ts)
generates all eight combinations, runs their lint, type and architecture checks,
adds test-owned SQL, handlers and controllers, and executes each distribution
outside the deleted workspace. It migrates and commits real PostgreSQL state,
exchanges and recovers real RabbitMQ work, degrades readiness on database loss,
keeps HTTP during broker loss and proves disabled capabilities need no settings
and never contact sentinel endpoints:

```sh
bun run nx run generators:test --skip-nx-cache
bun run nx run generators:test-component --skip-nx-cache
```

The live target owns unique labelled PostgreSQL and RabbitMQ containers and TCP
outage gates; cleanup verifies ownership and never deletes volumes. It runs with
the local `test:component` and `check:full` gates. Generation itself only writes the requested
app and does not alter User/Wallet, root start commands, database environments or
the lockfile.

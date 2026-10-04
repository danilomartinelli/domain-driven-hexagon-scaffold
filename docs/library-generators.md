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

| Preset                               | Layer         | Responsibility                                          |
| ------------------------------------ | ------------- | ------------------------------------------------------- |
| `ts-lib`                             | `core`        | Framework-free shared technical behavior                |
| `nest-lib` (default)                 | `adapter`     | Nest-facing technical adapters; no generated module     |
| `nest-lib --layer=composition`       | `composition` | Register and export an existing injectable provider     |
| `nest-app --preset=hybrid` (default) | application   | HTTP/GraphQL, recovering RabbitMQ and bounded lifecycle |

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

## Hybrid application

```sh
bun run nx generate @starter/generators:nest-app telemetry --preset=hybrid --dry-run
bun run nx generate @starter/generators:nest-app telemetry --preset=hybrid
bun run nx show project telemetry --json
bun run nx run telemetry:lint
bun run nx run telemetry:typecheck
bun run lint:boundaries
TELEMETRY_HTTP_PORT=3010 TELEMETRY_RABBITMQ_URL=amqp://localhost:5672 \
  bun run nx run telemetry:serve
```

`hybrid` is the only app preset. It uses the installed Nest 12 and Bun 1.4.2
directly, without an upstream Nest preset. Output includes:

```text
src/apps/telemetry/
  main.ts                    # bootstrap and shared bounded shutdown
  configs/environment.ts     # TELEMETRY_* variables, no dotenv loading
  application/message-handler.ts  # plain handler port and explicit identity
  adapters/                  # operational GraphQL and RabbitMQ lifecycle
  composition/app.module.ts   # explicit provider wiring, health and transports
  tests/unit/                # infrastructure-free native tests
  tests/component/           # separately selected live tests
```

The private manifest has `exports: {}` and the project has `scope:telemetry` and
`type:app` tags. No application becomes a shared library. HTTP health endpoints
and GraphQL `{ httpReady }` work with the broker down; RabbitMQ reconnects with
bounded exponential delay. Invalid or unsupported envelopes are confirmed into
`<queue>.failed` before acknowledgement. Register real handlers in composition;
the generator supplies no business rules, CRUD, complete use cases or tests.
Message identity is passed explicitly and GraphQL/DI metadata is declared for Bun.

Only `TELEMETRY_HTTP_PORT` and `TELEMETRY_RABBITMQ_URL` are required.
`TELEMETRY_RABBITMQ_QUEUE` defaults to `telemetry.commands.v1`; select unique queues
per environment. Use `telemetry:watch` and `telemetry:debug` for development.
SIGINT/SIGTERM refuses new work, drains accepted requests/deliveries and closes
messaging before Nest, with a 15-second process deadline.

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

Distribution carries the installed dependency closure and executes without the
workspace or sibling sources. The preset does not generate a database or migration
commands. To add persistence, follow the [application checklist](adding-an-application.md),
register the app's own database prefix and migrations, add migration dependencies to
its distribution manifest and use `DATABASE_APP=telemetry` for workspace commands.
Registered databases receive scoped migration commands in the artifact; unregistered
database content is rejected by packaging.

The [app generator tests](../scripts/tests/app-generator.test.ts) exercise the CLI,
dry-run/collision guarantees, project checks and a distribution after deleting its
scratch workspace. The [live probe](../scripts/tests/app-generator-live.test.ts)
adds only test-owned behavior and proves startup with a blocked broker, HTTP/GraphQL,
explicit message identity, recovery, retained invalid input and normal draining shutdown:

```sh
bun run nx run generators:test --skip-nx-cache
bun run nx run generators:test-component --skip-nx-cache
```

The live target owns a unique labelled RabbitMQ container and TCP outage gate;
cleanup verifies ownership and never deletes volumes. It runs with `test:component`,
`check:full` and CI. Generation itself only writes the requested app and does not
alter User/Wallet, root start commands, database environments or the lockfile.

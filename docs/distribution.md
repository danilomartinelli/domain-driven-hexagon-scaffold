# Independent service distributions

From a frozen install with Bun 1.4.2, run `bun run nx run user:distribution`
or `bun run nx run wallet:distribution`. Copy the entire resulting `dist/user`
or `dist/wallet` directory to a machine with the same OS/architecture and Bun
1.4.2. No sibling source or workspace is required.

[Generated applications](library-generators.md#application-capabilities) use the
same `<name>:distribution` target. Packaging reads `app/application.json`: an
application without declared persistence receives `start` and `preflight` and no database
migration interface; a persistent one additionally receives the scoped migration
tooling described below. Disabled persistence keeps owned SQL in the checkout but
omits migrations and their interface from the artifact. Generated
app artifacts include their own README with environment and transport instructions.

Each artifact contains `app/` TypeScript, its `application.json` declaration and
owned SQL migrations, private libraries and installed transitive runtime/migration
dependencies in `node_modules/`, standalone decorator configuration, and
`distribution.json` with the installed package inventory and the database metadata
derived from the declaration (prefix, runtime role and owned migration path). `workspace.bun.lock` records the source
lock; it is provenance, not an artifact install recipe. Dependencies are already
included: do not run an install inside the artifact. Rebuild from a frozen
workspace install when changing dependencies or target platform.

## Invocation

From the artifact directory:

```sh
bun --no-env-file run migration:up
bun --no-env-file run migration:status
bun --no-env-file run start
# Roll back the most recent owned migration:
bun --no-env-file run migration:down
```

The equivalent workspace targets are `user:serve-distribution`,
`user:migration-up-distribution`, `user:migration-status-distribution` and
`user:migration-down-distribution` (replace `user` with `wallet` for Wallet).
Run them with `bun run nx run <target>` after packaging.

## Configuration

Supply settings in the process environment; no dotenv files are loaded.
Use `USER` for a User artifact and `WALLET` for a Wallet artifact:

- `<APP>_HTTP_PORT`: HTTP/GraphQL port.
- `<APP>_DB_HOST`, `<APP>_DB_PORT`, `<APP>_DB_NAME`: owned PostgreSQL database.
- `<APP>_DB_USERNAME`, `<APP>_DB_PASSWORD`: restricted runtime credentials.
- `<APP>_DB_MIGRATION_USERNAME`, `<APP>_DB_MIGRATION_PASSWORD`: owner credentials,
  supplied only to migration commands. Never supply them to the running service.
- `RABBITMQ_HOST`, `RABBITMQ_PORT`, `RABBITMQ_USERNAME`, `RABBITMQ_PASSWORD`,
  `RABBITMQ_VHOST`: required broker configuration. Broker availability does not
  gate HTTP/GraphQL startup or User creation; message delivery requires RabbitMQ.

Provision an empty owned database and its login role (`user_runtime` or
`wallet_runtime`) before migration. Migrations grant the restricted role's
permissions; only the owner can migrate. Each artifact selects its own migration
directory and credential prefix. A conflicting `DATABASE_APP` is rejected.
The database name and host are operator-supplied, so use separate owner
credentials and databases for the two services.

Packaging copies the installed dependency closure, retaining nested versions and
materializing private workspace packages. Packaging is deliberately uncached;
execution and migration targets are also uncached and always run live.

Generated source `distribution.json` separates unconditional `dependencies` from
`integrations`. Each prepared integration lists its `dependencies` and application
relative `paths`. Packaging includes its dependency roots only when selected in
`application.json` and excludes its paths when disabled. The installed transitive
dependencies of selected roots remain included. Development images use the same
selection. The older array of unconditional dependencies remains supported.
Keep shared source outside capability-specific paths, and load optional adapters
inside their selected composition factories. Do not put required functionality in
an excluded path: register its requirements so preflight rejects incompatibility.

After a declaration change, rebuild the distribution or image from the retained
source. Delivered artifacts contain the selected composition's files and are not
an authoring checkout for preparing or reactivating omitted integrations. See the
[transition workflow](application-compatibility.md#disable-and-reactivate-prepared-integrations).

## Verification

Run `bun run preflight` inside a distribution before supplying credentials or
provisioning dependencies. The [compatibility contract](application-compatibility.md)
uses the same functionality registrations as runtime composition and needs no
workspace, sibling application, database or broker.

```sh
bun run nx run user:test-distribution
bun run nx run wallet:test-distribution
bun run test:distribution
bun run nx run user:test-component
bun run nx run wallet:test-component
```

Each distribution check packages into a new directory under the system temporary
folder, outside the workspace. It provisions only the owning PostgreSQL database
and RabbitMQ, then runs the artifact's migration and startup commands with no
workspace aliases, workspace package links or sibling credentials. User REST and
GraphQL commit pending events with the broker unreachable, survive restart and
accept `user.create` without Wallet. Wallet looks up absence, consumes a fixed
`user.created` envelope and exposes the committed Wallet through both APIs.

The checks also reject a sibling migration selector and runtime migration
credentials, inspect committed database state, and clean owned resources.
User and Wallet targets each run two sequential commands in separate disposable
environments: business scenarios, then image shutdown scenarios. The latter skip
when no image is selected, preserving plain host distribution checks.

During preparation and the full image suite, the resolved Nx graph selects each
application's optional `test-distribution` target after artifact approval. Targets
receive `DDH_VALIDATED_IMAGE` (immutable image ID) and `DDH_IMAGE_PLATFORM` and must
execute that platform image. This is a documented target contract, not runtime
enforcement. Missing targets are logged; their applications need approval alone.
Failing scenarios withhold the approval receipt. Both
component suites independently provision the capabilities declared by their selected app;
cross-database permission checks belong to distributed E2E. Local `check:full`
includes distribution verification; CI executes OCI images separately. No live
verification result is cached.

## Linux OCI images

Build one selected application, including generated names, without a central list:

```sh
bun run image:build user --platform=linux/arm64 --tag=ddh-user:arm64
bun run image:build wallet --platform=linux/amd64 --tag=ddh-wallet:amd64
# Substitute a generated application name:
bun run image:build reports --platform=linux/arm64 --tag=ddh-reports:local
```

The platform defaults to the local machine architecture. Docker must support
execution of the selected Linux platform, either natively or through emulation.
The build context is allowlisted, excludes host dependencies and operator files,
and contains only the selected application's implementation. Bun installs the
frozen lockfile inside the target Linux build stage. The final image contains
only the independent distribution, its runtime/migration dependency closure and
Bun. It omits seeds, test fixtures, sibling implementations and operator secrets.
Images need neither a source checkout nor an install on startup.

The default command runs Bun directly as PID 1. Persistent images also run the
separate owning migration interface; supply an existing private network and
separate environment files containing the documented settings:

```sh
docker run --rm --network "$APP_NETWORK" --env-file "$OWNER_ENV" ddh-user:arm64 run migration:status
docker run --rm --network "$APP_NETWORK" --env-file "$OWNER_ENV" ddh-user:arm64 run migration:up
docker run --name user --network "$APP_NETWORK" --env-file "$RUNTIME_ENV" ddh-user:arm64
docker stop --time=20 user
```

No business port is published by these commands. Startup never runs migrations.
Nonpersistent images have no migration scripts or database tooling. Runtime
roles cannot run migrations, and another `DATABASE_APP` is rejected. Owner files
belong only to the one-shot migration process. Local builds produce images only; registry publication and deployment are separate
actions.

For manual one/all GHCR publication of these exact validated artifacts, see
[explicit public image publication](publication.md). It records commit identity
and immutable digests without deploying an environment.

```sh
bun run test:images                         # execute both supported architectures
bun run test:images --platform=linux/arm64   # one target for focused feedback
bun run test:images:light                   # CI subset: build, reproduced defects, startup
```

These uncached checks discover application distribution targets, including the
User/Wallet fixtures with real
PostgreSQL and RabbitMQ, execute business requests through Kong, reject direct
host access, exercise drain/deadline/restart outcomes and execute all eight
capability combinations as generated images. Their containers have no checkout
mounts. Logs under `.context/image-checks/` record runtime architecture, Docker
host architecture and native versus emulated execution.

On 2026-10-05, User and Wallet executed on `linux/arm64` natively and
`linux/amd64` through emulation on an ARM64 Docker host. Both exercised owned
migration/status/rollback, REST/GraphQL, messaging and restart. The generated
capability matrix also executed on both architectures. CI runs the light subset on
native Ubuntu runners for each architecture; a green build alone is not execution
evidence. The on-demand full local gate includes every image suite on both paths.

## Operate a Compose host

Use the [Compose operations guide](operations.md) for digest selection, scoped file
secrets, HTTPS, explicit migrations, update/rollback, diagnosis and per-application
backup/restore. The same image serves both runtime and owned migration commands.

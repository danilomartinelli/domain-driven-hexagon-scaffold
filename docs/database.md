# Workspace database workflow

Use Bun 1.4.2 and Docker from the repository root. Install dependencies with
`bun install --frozen-lockfile`. The Nx-backed environment commands provision
PostgreSQL 18.6 and RabbitMQ (official management image pinned by digest).
Each environment belongs to the real workspace path and a named run.

## Development

Conductor users can use the [workspace setup and Run commands](conductor.md)
for an isolated development environment and an allocated application port.

```sh
bun run env:prepare --environment=development --run=default
bun run env:exec --environment=development --run=default -- bun run migration:up
bun run env:exec --environment=development --run=default -- bun run seed:up
bun run env:exec --environment=development --run=default -- bun run start:dev
# Stop containers and their network; keep all named volumes.
bun run env:down --environment=development --run=default
```

Preparing the same development environment again reuses its manifest, ports,
credentials and volumes. Migrations and seeds are explicit, separate operations.
These commands select the `legacy` application; the
[Wallet guide](wallet.md#run-it-locally) migrates, seeds and starts Wallet
from the same environment. `docker:env` is an alias for preparing
development's `default` run.

## Disposable tests

The complete workflow chooses a fresh run, prepares infrastructure, invokes the
selected applications' database migration and seed commands, runs the suite,
and attempts owned-resource shutdown even after failure or interruption:

```sh
bun run test:e2e
bun run test:e2e --test-name-pattern 'Wallet persistence failure'
bun run test:component
```

`test:e2e` selects `legacy` and `test:component` selects `wallet` through
`scripts/with-test-database.ts --app=<name> -- <command>`. Without `--app`, the
wrapper migrates and seeds every registered application. Every registered
database is provisioned either way.

For repeated, targeted runs against prepared infrastructure:

```sh
bun run env:prepare --environment=test --run=regression-1
bun run env:exec --environment=test --run=regression-1 -- bun run migration:up:tests
bun run env:exec --environment=test --run=regression-1 -- bun run seed:up:tests
bun run env:exec --environment=test --run=regression-1 -- bun run test:e2e:prepared
bun run env:exec --environment=test --run=regression-1 -- bun test --preload ./tests/setup/preload.ts ./tests/user/create-user/create-user.test.ts
bun run env:down --environment=test --run=regression-1
```

Use a new test run name after shutdown; test names cannot be reused. `docker:tests`
prepares the test run named `default`. It does not migrate or seed. Direct
`test:e2e:prepared`, `migration:*:tests` and `seed:up:tests` require the selected
owned environment, normally supplied through `env:exec`.
The final Makefile aliases belong to the full workflow slice of issue #15.

## Isolation and configuration

Project names are `ddh-test-<workspace hash>-<run>` or
`ddh-dev-<workspace hash>-<run>`. Container names, networks, application database
names, development volumes and RabbitMQ virtual hosts include that scope.
RabbitMQ has a stable scoped hostname so its node data survives development
container recreation ([node naming](https://www.rabbitmq.com/docs/clustering)).
Each application gets a PostgreSQL container; tests use tmpfs, development uses
new named volumes. No command deletes a volume or transfers legacy data.
The older `docker/docker-compose.yml` is retained only for accessing existing
resources; it is no longer called by package commands. Its `ddh` volumes are
not adopted by the new workflow.

All published infrastructure ports bind to loopback. Ports are allocated per
run, or explicitly selected at first preparation with `DB_PORT`,
`WALLET_DB_PORT`, `RABBITMQ_PORT` and `RABBITMQ_MANAGEMENT_PORT`. An occupied
port fails startup and triggers cleanup. Allocation cannot reserve a port
across Docker startup; a race also fails closed and can be retried with a fresh run.

The manifest also reserves `GATEWAY_NAME`, `GATEWAY_HOST` (default
`host.docker.internal`), `GATEWAY_PROXY_PORT`, `GATEWAY_ADMIN_PORT`,
`USER_HTTP_PORT` and `WALLET_HTTP_PORT` for the later Kong routing slice.
Those ports and host are configurable at preparation. Kong is not started yet;
Wallet already listens on `WALLET_HTTP_PORT`, the other ports are coordinates.

The generated manifest and Compose configuration live under
`.context/test-runs/<project>/` with owner-only file permissions. Treat them as
local credentials. `run.log` and `result.json` retain command/cleanup statuses
and, for `bun test` commands, pass/fail counts. Container logs stay in `run.log`
and reach the terminal only when a run fails; every run ends with one `Result:`
line naming its statuses, counts and log.
The manifest provides database and broker settings to `env:exec`; shell values
win over defaults. **Tests reject an override that differs from the selected
owned target**, instead of silently replacing it or connecting to it.
Development commands may intentionally use shell overrides.

Bun automatic environment loading is disabled in `bunfig.toml`, and Nx dotenv
loading is disabled by the package wrapper. The application's dotenv loader
skips `.env`/`.env.test` inside a selected environment. Outside that workflow,
legacy development commands still read `.env` with shell precedence.
Tests never authorize cleanup based on a name containing `test`.

Before opening any application pool or database-tool connection, and again
before each test truncation, the guard checks the ready test manifest and every
configured database's host, port, username, password and scoped name,
including migration credentials. Unknown `*_DB_*` and `*_DB_MIGRATION_*`
targets and database URLs are rejected, so adding a future service cannot
silently bypass the guard. Shutdown derives configuration from the
selected manifest and checks owner labels on containers, networks and volumes;
it never derives a Compose project from a caller's database URL.

Readiness has a 60-second Compose deadline within a 90-second process deadline.
Migrations and seeds each have 60 seconds; test commands have five minutes.
`env:exec --environment=development` has no command deadline, so watch servers
keep running until they exit or receive a signal.
Each ownership inspection/log command has 15 seconds; Compose shutdown has 30
seconds. SIGINT/SIGTERM terminate the active process group, with forced
termination after five seconds, then attempt cleanup and return 130/143.
A cleanup failure turns a successful wrapped test run into failure. A forcibly
killed runner or unavailable Docker daemon may leave resources for a later
`env:down` using the same run ID.

## Application-owned database content

`database/applications.ts` registers each application's environment-variable
prefix, migration directory, ordered seed files and optional runtime role. The
transitional `legacy` application (`DB_*`, content in `database/`) is the
default. `wallet` (`WALLET_DB_*`) owns its content in `src/apps/wallet/database/`
and a new database with its own migration history; no data is transferred.
Select an application with `DATABASE_APP`; unknown applications fail before
connecting. The orchestrator iterates the registry to provision, migrate, seed
and validate every target.

```sh
bun run migration:create add-user-index
DATABASE_APP=wallet bun run migration:create add-wallet-index
DATABASE_APP=legacy bun run env:exec --environment=test --run=regression-1 -- bun run migration:status:tests
DATABASE_APP=legacy bun run env:exec --environment=test --run=regression-1 -- bun run migration:down:tests
```

An application with a runtime role separates migration authority from runtime
access. Its database owner (`<prefix>_MIGRATION_USERNAME`/`_PASSWORD`) runs
migrations and seeds; the application connects as the restricted role
(`<prefix>_USERNAME`/`_PASSWORD`), which the environment creates when it
initializes the cluster and the migrations grant only what the application
needs. Wallet's `wallet_runtime` can only read `wallets`. Each application
database runs in its own PostgreSQL container, so neither Wallet credential can
connect to another application's database; Wallet's component suite verifies
both properties. The legacy database still uses its owner for both.

Registering an application changes existing manifests. The next `env:prepare`
of a development run adds the new database, with new ports and credentials,
and keeps the existing databases, credentials and volumes; `env:exec` asks for
that preparation first, while `env:down` still works. Test runs cannot be
prepared again, so use a new run.

SQL files retain `-- Up Migration` and `-- Down Migration` sections.
`node-pg-migrate` owns each database's `public.pgmigrations`, transaction and
advisory lock. `up` applies pending migrations, `down` rolls back the latest,
and `status` lists applied/pending history. Each baseline must start in an
empty database; rolling back the legacy baseline drops its User and Wallet
tables and their data, and Wallet's drops its `wallets` table.

Seeds run explicitly after migrations in one transaction. The legacy fixture
is `john@gmail.com` with a zero-balance Wallet; Wallet's seed is a zero-balance
lookup example for the same User identity, with no event scheduled to create
it again. Seeds are not idempotent: a second insertion fails and rolls back.
Application tests clear those fixtures before the first case and between cases.
Migration history remains intact.

See [developer checks](developer-checks.md) for the current gate and
[ADR 0002's implementation status](adr/0002-adopt-nx-with-nest-and-bun.md#implementation-status)
for the remaining service split.

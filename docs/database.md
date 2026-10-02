# Workspace database workflow

Use Bun 1.4.2 and Docker from the repository root. Install dependencies with
`bun install --frozen-lockfile`. The Nx-backed environment commands provision
PostgreSQL 18.6, RabbitMQ and Kong 3.9.1 (broker and gateway images pinned by digest).
Each environment belongs to the real workspace path and a named run.

## Development

Conductor users can use the [workspace setup and Run commands](conductor.md)
for an isolated development environment and an allocated application port.

```sh
bun run env:prepare --environment=development --run=default
for app in user wallet; do
  DATABASE_APP="$app" bun run env:exec --environment=development --run=default -- bun run migration:up
  DATABASE_APP="$app" bun run env:exec --environment=development --run=default -- bun run seed:up
done
bun run env:exec --environment=development --run=default -- bun run start:dev
# Stop containers and their network; keep all named volumes.
bun run env:down --environment=development --run=default
```

Preparing the same development environment again reuses its manifest, ports,
credentials and volumes. Migrations and seeds are explicit, separate operations.
Migration and seed commands default to `user`; use `DATABASE_APP=wallet` for
Wallet. `start:dev` runs both independent processes. The [Wallet guide](wallet.md#run-it-locally)
and [User guide](user.md#run-it-locally) describe running one service.
`docker:env` is an alias for preparing
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

`test:e2e` migrates/seeds both applications; `test:component` runs separate `user` and `wallet`
suites through
`scripts/with-test-database.ts --app=<name> -- <command>`. Without `--app`, the
wrapper migrates and seeds every registered application. Every registered
database is provisioned either way.

For repeated, targeted runs against prepared infrastructure:

```sh
bun run env:prepare --environment=test --run=regression-1
for app in user wallet; do
  DATABASE_APP="$app" bun run env:exec --environment=test --run=regression-1 -- bun run migration:up:tests
  DATABASE_APP="$app" bun run env:exec --environment=test --run=regression-1 -- bun run seed:up:tests
done
bun run env:exec --environment=test --run=regression-1 -- bun run test:e2e:prepared
bun run env:exec --environment=test --run=regression-1 -- bun test --preload ./tests/setup/preload.ts ./tests/user/create-user/create-user.test.ts
bun run env:down --environment=test --run=regression-1
```

Use a new test run name after shutdown; test names cannot be reused. `docker:tests`
prepares the test run named `default`. It does not migrate or seed. Direct
`test:e2e:prepared`, `migration:*:tests` and `seed:up:tests` require the selected
owned environment, normally supplied through `env:exec`.
The final Makefile aliases belong to the full workflow slice of issue #15.

### Fault injection

For distributed outage scenarios, use
[`withServiceFault`](../tests/setup/operations.ts). It selects the container by
the current test manifest's owner, project and service labels, and restores it
after success or failure while preserving scenario and cleanup errors.
`mode: 'unresponsive'` pauses the process and preserves existing data; it models
a stalled dependency. `mode: 'stopped'` models a stopped process. Stopping a
container backed by tmpfs destroys its data, so that mode rejects tmpfs unless
the scenario explicitly sets `allowDataLoss: true`, as the broker-loss tests do.

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
run, or explicitly selected at first preparation with `USER_DB_PORT`, `WALLET_DB_PORT`, `RABBITMQ_PORT` and `RABBITMQ_MANAGEMENT_PORT`. An occupied
port fails startup and triggers cleanup. Allocation cannot reserve a port
across Docker startup; a race also fails closed and can be retried with a fresh run.

The manifest configures `GATEWAY_NAME`, `GATEWAY_HOST` (default
`host.docker.internal`), `GATEWAY_PROXY_PORT`, `GATEWAY_ADMIN_PORT`,
`USER_HTTP_PORT` and `WALLET_HTTP_PORT`. Those ports and host are configurable
at first preparation. Kong runs in its own container; User and Wallet keep
running on the host with Bun, listening on their selected HTTP ports.
Tests reject overrides of gateway identity, host and ports as well as database
and broker overrides. Keep development gateway/HTTP settings consistent with
the prepared manifest; changing only `env:exec` cannot reconfigure Kong.

The generated manifest and Compose configuration live under
`.context/test-runs/<project>/` with owner-only file permissions. Treat them as
local credentials. `run.log` and `result.json` retain command/cleanup statuses
and, for `bun test` commands, pass/fail counts. Container logs stay in `run.log`
and reach the terminal only when a run fails. A failed command repeats a bounded,
ANSI-free failure excerpt after cleanup so verbose container output does not hide
the diagnostic. Every run ends with one `Result:` line naming its statuses,
counts and log. Failed CI jobs upload only `run.log` and `result.json` as the
`test-run-diagnostics-<attempt>` artifact, retained for seven days; generated
manifests and Compose configuration are excluded.
The manifest provides database and broker settings to `env:exec`; shell values
win over defaults. **Tests reject an override that differs from the selected
owned target**, instead of silently replacing it or connecting to it.
Development commands may intentionally use shell overrides.

Bun automatic environment loading is disabled in `bunfig.toml`, and Nx dotenv
loading is disabled by the package wrapper. Database tooling skips dotenv inside
a selected environment. Outside that workflow, database commands read `.env`
with shell precedence; both applications always read only process settings.
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

## Gateway URLs

Follow [Development](#development) to start Docker infrastructure, migrate each
database and start both host applications through the same `env:exec` selection.
Preparation waits for Kong's own healthcheck; it does not start the applications
or make their upstreams ready. Requests need the corresponding host application
running. RabbitMQ delivery to a running Wallet is required for a newly created
User's Wallet to become visible.

All public HTTP operations use one base URL, `http://127.0.0.1:<GATEWAY_PROXY_PORT>`:

| Operation         | Gateway URL                                                        |
| ----------------- | ------------------------------------------------------------------ |
| Create/list Users | `http://127.0.0.1:<GATEWAY_PROXY_PORT>/v1/users`                   |
| Delete a User     | `http://127.0.0.1:<GATEWAY_PROXY_PORT>/v1/users/:id`               |
| Look up a Wallet  | `http://127.0.0.1:<GATEWAY_PROXY_PORT>/v1/wallets/by-user/:userId` |
| User GraphQL      | `http://127.0.0.1:<GATEWAY_PROXY_PORT>/user/graphql`               |
| Wallet GraphQL    | `http://127.0.0.1:<GATEWAY_PROXY_PORT>/wallet/graphql`             |

Print the exact URLs for the prepared run (use `--run=conductor` for Conductor):

```sh
bun run env:exec --environment=development --run=default -- bun -e 'const base = "http://127.0.0.1:" + process.env.GATEWAY_PROXY_PORT; for (const path of ["/v1/users", "/v1/wallets/by-user/:userId", "/user/graphql", "/wallet/graphql"]) console.log(base + path);'
```

The [versioned declarative route template](../docker/kong.json) is rendered with
the manifest's container-to-host address and application ports. Kong runs in
[DB-less mode](https://developer.konghq.com/gateway/db-less-mode/). REST paths,
query strings and bodies are preserved; each GraphQL route maps to its owning
application's `/graphql`. There is no combined `/graphql` endpoint or federation.
Kong routes HTTP only; RabbitMQ remains the service-event transport. Pending
Wallet lookup returns REST 404 or GraphQL `walletByUser: null`. Deleting a User
does not delete its Wallet or cancel a pending creation event.

Docker Desktop supplies `host.docker.internal`; the Compose `host-gateway` mapping
also supports Linux Docker Engine. Host applications must listen on an interface
reachable from the container, as the default Nest listeners do. Set `GATEWAY_HOST`
at preparation if your Docker environment requires another reachable address.
The local Admin API is `http://127.0.0.1:<GATEWAY_ADMIN_PORT>`; it is separate from
the public proxy and bound to loopback. Development and test gateways have
distinct names, ports and owner labels. Failed setup and normal shutdown use the
same ownership checks and preserve sibling runs and development volumes.

`bun run test:e2e` runs all seven Gherkin cases and API regressions through Kong;
component tests continue to address their independent service directly.

## Application-owned database content

`database/applications.ts` registers each application's environment-variable
prefix, migration directory, ordered seed files and optional runtime role. The
`user` application (`USER_DB_*`, content in `src/apps/user/database/`) is the
default. `wallet` (`WALLET_DB_*`) owns its content in `src/apps/wallet/database/`.
Each has a new database with its own migration history; no data is transferred.
Select an application with `DATABASE_APP`; unknown applications fail before
connecting. The orchestrator iterates the registry to provision, migrate, seed
and validate every target.

```sh
bun run migration:create add-user-index
DATABASE_APP=wallet bun run migration:create add-wallet-index
DATABASE_APP=user bun run env:exec --environment=test --run=regression-1 -- bun run migration:status:tests
DATABASE_APP=user bun run env:exec --environment=test --run=regression-1 -- bun run migration:down:tests
```

An application with a runtime role separates migration authority from runtime
access. Its database owner (`<prefix>_MIGRATION_USERNAME`/`_PASSWORD`) runs
migrations and seeds; the application connects as the restricted role
(`<prefix>_USERNAME`/`_PASSWORD`), which the environment creates when it
initializes the cluster and the migrations grant only what the application
needs. Wallet's `wallet_runtime` can read and insert `wallets` and
`wallet_consumed_events`, but cannot update balances, delete records or change
the schema. User's `user_runtime` can read, insert and delete profiles and read/insert
pending events, and update only their `published_at`; it cannot delete events,
rewrite envelopes or change the schema. Each application
database runs in its own PostgreSQL container, so neither Wallet credential can
connect to another application's database; both component suites verify
the final User/Wallet role restrictions.

Registering an application changes existing manifests. The next `env:prepare`
of a development run adds the new database, with new ports and credentials,
and keeps the existing databases, credentials and volumes. Retired legacy
development resources remain stoppable and preserved but are never created in
new runs or available as migration/seed targets; `env:exec` asks for
that preparation first, while `env:down` still works. Test runs cannot be
prepared again, so use a new run.

SQL files retain `-- Up Migration` and `-- Down Migration` sections.
`node-pg-migrate` owns each database's `public.pgmigrations`, transaction and
advisory lock. `up` applies pending migrations, `down` rolls back the latest,
and `status` lists applied/pending history. Each baseline must start in an
empty database. Rolling back an application baseline removes only that
application's tables and data.

Seeds run explicitly after migrations in one transaction. Wallet's seed is a
zero-balance lookup example for `f59d0748-d455-4465-b0a8-8d8260b1c877`, with no event scheduled to create
it again. User's independent seed uses a distinct profile identity and one
pending event, with no direct Wallet insertion for that identity. Seeds are not idempotent: a second insertion fails and rolls back.
System tests stop both processes, purge their queues and clear both databases
before restarting each scenario. Component fixtures own their separate resources.
Migration history remains intact.

See [developer checks](developer-checks.md) for the current gate and
[ADR 0002's implementation status](adr/0002-adopt-nx-with-nest-and-bun.md#implementation-status)
for the remaining service split.

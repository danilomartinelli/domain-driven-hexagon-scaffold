# Workspace database workflow

Use Bun 1.4.2 and Docker from the repository root. Install dependencies with
`bun install --frozen-lockfile`. The Nx-backed environment commands provision
PostgreSQL 18.6, RabbitMQ and Kong 3.9.1 (broker and gateway images pinned by digest).
Each environment belongs to the real workspace path and a named run.

## Development

Conductor users can use the [workspace setup and Run commands](conductor.md)
for an isolated development environment and an allocated application port.

```sh
make dev   # bun run dev: prepare, migrate persistent selections, watch selected applications
make down  # bun run dev:down: stop containers and their network; keep named volumes
```

`bun run dev` runs the uncached `infrastructure:dev` target for development's
`default` run (`--run=<id>` selects another). It derives infrastructure from the selected declarations, waits for service
healthchecks, applies pending migrations for selected persistent applications,
then runs `start:dev` with the manifest's settings. The
infrastructure keeps running after the applications or migrations exit;
`make down` stops it. A failed infrastructure startup removes only that run's
containers and network. `make dev` never seeds: seeds are not idempotent, so
insert the examples once while the environment is running:

```sh
for app in user wallet; do
  DATABASE_APP="$app" bun run env:exec --environment=development --run=default -- bun run seed:up
done
```

For targeted work, `env:prepare` provisions without migrating, `env:exec` runs
one command with the manifest's settings, and `env:down` stops a selected run:

```sh
bun run env:prepare --environment=development --run=default
DATABASE_APP=wallet bun run env:exec --environment=development --run=default -- bun run migration:status
bun run env:exec --environment=development --run=default -- bun run start:user:dev
bun run env:down --environment=development --run=default
```

Preparing the same development environment again reuses its manifest, ports,
credentials and volumes. Migration and seed commands default to `user`; use
`DATABASE_APP=wallet` for Wallet. `start`, `start:dev` and `start:debug` discover selected applications and run their
`serve`, `watch` and `debug` targets respectively. Outside an environment they
discover every declared application.
The [Wallet guide](wallet.md#run-it-locally) and [User guide](user.md#run-it-locally)
describe running one service. `docker:env` is an alias for preparing
development's `default` run.

## Selection and retained resources

```sh
bun run env:prepare --environment=development --run=selected --app=user
bun run dev --run=selected
bun run env:inspect --environment=development --run=selected
bun run env:down --environment=development --run=selected
```

Repeat `--app=<name>` on preparation or `dev` to select multiple applications.
A new run without a selection follows all declarations. An explicit selection is
remembered on later prepares; supply the complete new selection to change it.
A removed selected declaration becomes inactive, and restoring it reactivates it.
For an unscoped run, new declarations join automatically. No central name or port
list needs editing. Each selected application gets a stable `<NAME>_HTTP_PORT`,
including applications with private operational HTTP only. Generated messaging
applications also receive `<NAME>_RABBITMQ_URL`; existing applications retain the
shared `RABBITMQ_*` interface.

| Capability   | Active infrastructure and configuration                                 |
| ------------ | ----------------------------------------------------------------------- |
| Persistence  | One owning PostgreSQL instance and database credentials per application |
| Messaging    | One shared RabbitMQ instance and scoped vhost                           |
| Exposure     | One shared DB-less Kong; only explicitly declared routes are registered |
| All disabled | Operational application ports; none of the infrastructure above         |

Development databases and RabbitMQ use persistent named volumes. Disposable test
runs retain their existing tmpfs contract and cannot be prepared again after
shutdown. Combined selections provision exactly the union of their requirements.
Disabled capabilities contribute no dependency credentials or migration commands.

The manifest separates the last prepared `topology` from its retained database,
broker, gateway and application-port inventory. Disabling a capability, excluding
an application or removing its declaration stops inactive services but retains
credentials, resource ownership, volumes and accepted queued work. No queue is
purged during reconciliation. Active producers may continue publishing while a
consumer is inactive; consumer count is not queue ownership or cancellation.
Reactivation reuses the same inventory and resumes with the retained state.
Preparation recreates the stateless gateway to load changed routes, including
removals; this can briefly interrupt local gateway traffic.

`env:inspect` checks ownership and reports active and retained resource identities
without printing passwords. `env:down` discovers and stops retained resources even
when their application declaration has disappeared. Preparation, inspection and
shutdown refuse foreign resource owners. No command retires resources or deletes
volumes. Direct manifest edits are unsupported; keep `.context/test-runs/` to retain
resource identities. After editing declarations, prepare before `env:exec`.

### Explicit public routes

Each application owns its routes in `application.json`; generation registers none:

```json
{
  "name": "reports",
  "persistence": false,
  "messaging": false,
  "exposure": true,
  "routes": [
    {
      "name": "rest",
      "paths": ["~/v1/reports(?:/|$)"],
      "methods": ["GET"],
      "stripPath": false
    },
    {
      "name": "graphql",
      "paths": ["~/reports/graphql/?$"],
      "stripPath": true,
      "upstreamPath": "/graphql"
    }
  ]
}
```

`paths` and optional `methods` select requests; `stripPath` and optional
`upstreamPath` control forwarding. Route names must be distinct within an app.
With exposure disabled, its route declarations contribute nothing to Kong.
Operational probes, documentation and GraphQL are never registered implicitly.
Application listeners run on the host.

## Disposable tests

The complete workflow chooses a fresh run, prepares infrastructure, invokes the
selected applications' database migration and seed commands, runs the suite,
and attempts owned-resource shutdown even after failure or interruption.
`make test` runs `bun run test:e2e`:

```sh
bun run test:e2e
bun run test:e2e --test-name-pattern 'Wallet persistence failure'
bun run test:component
```

`test:e2e` migrates/seeds both applications; `test:component` runs separate `user` and `wallet`
suites through
`scripts/with-test-database.ts --app=<name> -- <command>`. Repeat `--app=<name>` to select applications. Their declarations determine the
union of databases, broker and gateway; migrations and seeds run only for selected
persistent applications. Without `--app`, the wrapper selects every declaration. Cross-database
credential rejection runs in the distributed suite.

Distribution verification uses `--no-database-setup` so each isolated artifact
initializes its own empty database with its delivered migration command. See
[independent distributions](distribution.md).

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
The distributed E2E fixture checks its HTTP ports again before spawning each
application, so a listener that appeared after allocation cannot satisfy the
startup probe. This check is not a reservation across process startup: a test-only
child preload tags HTTP responses with a fresh process identity, and the startup
probe rejects responses from another listener. A setup or reset failure blocks
later scenarios with the original error and closes each
pool once; it does not retry against closed resources or mark scenarios passed.
HTTP ports stay fixed because Kong routes to the selected manifest.

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
counts and log. Disposable workspace fixtures copy only `run.log` and
`result.json` back to the source checkout's `.context/test-runs/` before removal,
including runs nested under Nx. An export failure retains the temporary workspace
and fails the run. Workspace fixtures automatically keep their runnable workspace
and private inventory under `.context/retained-workspaces/` whenever a manifest
contains development databases or a broker, including inactive resources and
failed shutdowns. No retention flag is required. Unreadable inventory also retains
the workspace and fails cleanup; diagnostic export is still attempted. Copies
without durable development inventory are removed after diagnostic export.
Use `env:inspect` or `env:down` from the printed retained workspace path.
Failed CI jobs upload only `run.log` and `result.json` as the
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
Under Nx, Ctrl-C stops the task tree leaf-first and force-kills survivors after
its grace period; the `nx` wrapper sets `NX_PROCESS_KILL_GRACE_PERIOD` to 90
seconds so the runner can finish these bounded steps and record its result.
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

The [gateway renderer](../scripts/lib/gateway.ts) reads explicit `routes` from
the selected applications' declarations and uses the manifest's container-to-host
address and application ports. Kong runs in
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

`database/applications.ts` derives the database applications from each
`src/apps/<name>/application.json` that declares `"persistence": true`; there is
no list of names to edit. Each one uses the `<NAME>_DB_*` environment prefix
(`order-history` becomes `ORDER_HISTORY_DB_*`), owns
`src/apps/<name>/database/migrations/`, runs optional seeds from
`src/apps/<name>/database/seeds/*.sql` in file-name order and connects through
the restricted `<name>_runtime` role (hyphens become underscores). The `user`
application (`USER_DB_*`, content in `src/apps/user/database/`) is the default.
`wallet` (`WALLET_DB_*`) owns its content in `src/apps/wallet/database/`.
Each has a new database with its own migration history; no data is transferred.
Select an application with `DATABASE_APP`; unknown or nonpersistent applications
fail before connecting, as does a malformed or misnamed declaration; directories
without `application.json` are skipped. The orchestrator iterates the derived list to provision, migrate,
seed and validate every target.

```sh
bun run migration:create add-user-index
DATABASE_APP=wallet bun run migration:create add-wallet-index
DATABASE_APP=user bun run env:exec --environment=test --run=regression-1 -- bun run migration:status:tests
DATABASE_APP=user bun run env:exec --environment=test --run=regression-1 -- bun run migration:down:tests
```

An application with a runtime role separates migration authority from runtime
access. Its database owner (`<prefix>_MIGRATION_USERNAME`/`_PASSWORD`) runs
migrations and seeds; the application connects as the restricted role
(`<prefix>_USERNAME`/`_PASSWORD`), which preparation reconciles after database health, including on an existing
cluster. Missing roles are created with the retained credentials; existing roles
and passwords are not replaced. Migrations grant only what the application needs. Wallet's `wallet_runtime` can read and insert `wallets` and
`wallet_consumed_events`, but cannot update balances, delete records or change
the schema. User's `user_runtime` can read, insert and delete profiles and read/insert
pending events, and update only their `published_at`; it cannot delete events,
rewrite envelopes or change the schema. Each application
database runs in its own PostgreSQL container, so neither Wallet credential can
connect to another application's database; both component suites verify
the final User/Wallet role restrictions.

Registering an application changes the selected topology on the next preparation.
Development reconciliation adds its resources without rotating existing credentials
or changing retained ports. Test runs remain single-use; prepare a new run after
changing declarations. Existing pre-capability development manifests are upgraded
without reallocating their known listener ports or adopting legacy external volumes.

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

See [developer checks](developer-checks.md) for the current gate and the
[migration evidence map](migration-evidence.md) for the delivered service split.

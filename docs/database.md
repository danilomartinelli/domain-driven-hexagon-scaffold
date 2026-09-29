# Local database workflow

Use **Bun 1.4.2** as the package manager and database-command runtime. The version
is pinned in `.bun-version` and `package.json`; `bun.lock` is committed. Run all
commands below from the repository root:

```sh
bun --version # 1.4.2
bun install --frozen-lockfile
cp .env.example .env # first setup only; preserve an existing .env
```

If you already have a `.env` for the bundled Compose database, keep your other
settings and change its `DB_PORT` from `5432` to `5433` before running the
application, migrations, or seeds. Connection URIs now honor `DB_PORT`; the old
value targets port `5432` instead of the development service published on `5433`.

Migrations use stable `node-pg-migrate` **9.0.0** with `pg` **8.23.0**. The `.mjs`
entry points run directly under Bun, independently of the application's TypeScript
toolchain and Slonik. Node, `ts-node`, and `jiti` are not used to execute these
commands or SQL migrations. `jiti` remains an accepted transitive dependency of
the migrator. The application and Gherkin cases also run directly under Bun;
see the [runtime guide](runtime.md). The database scripts are included in the strict type and lint checks described
in [developer checks](developer-checks.md).

## PostgreSQL and connections

The Compose file pins `postgres:18.6-alpine`. PostgreSQL has a five-year support
policy rather than separate LTS releases; 18.6 was the current maintained stable
18.x release when selected, with support through November 2030. See the
[PostgreSQL version policy](https://www.postgresql.org/support/versioning/).
PostgreSQL 18 stores its cluster below `/var/lib/postgresql`; the Compose mounts
follow the [official image's layout](https://hub.docker.com/_/postgres).

| Purpose     | Command                | Service         | Host connection            | Storage                                          |
| ----------- | ---------------------- | --------------- | -------------------------- | ------------------------------------------------ |
| Development | `bun run docker:env`   | `postgres`      | `localhost:5433/ddh`       | Named volume `ddh-postgres-18`                   |
| Validation  | `bun run docker:tests` | `postgres-test` | `localhost:5434/ddh_tests` | Separate container, temporary memory-backed data |

Both services use the local example credentials `user` / `password`, bind only to
loopback, and wait for a TCP health check. This skips the socket-only temporary
server used during first-time initialization. Starting or stopping the validation
service does not operate on development data. Stopping the validation container
discards its data; rerun the baseline after starting it again. The new development
volume also avoids attaching a legacy PostgreSQL data directory to the new major version.
No conversion of an existing database or migration history is provided.

The shared connection settings read `.env` for development and `.env.test` when
`NODE_ENV=test`. Shell-provided `DB_HOST`, `DB_PORT`, `DB_USERNAME`, `DB_PASSWORD`,
and `DB_NAME` take precedence. Credentials/database names are URL-encoded and
the configured port is included in the application's and commands' connection URI.
`bunfig.toml` disables Bun's automatic env loading so `bun run ...:tests` cannot
inherit development values loaded by the parent Bun process before `NODE_ENV`
is set. Use the validation settings below with no development `DB_*` shell overrides.

Optional pgAdmin:

```sh
docker compose -p ddh -f docker/docker-compose.yml --profile tools up -d pgadmin
```

It is available on `localhost:5050` with `admin@email.com` / `admin`; connect to
the Compose hostname `postgres` or `postgres-test` on port `5432`.

## SQL migrations

The baseline replaces the old Slonik migration history. Apply it to an **empty**
database, not a database containing the legacy `users`/`wallets` tables. Existing
identifiers, camel-case columns, `timestamptz` dates, integer wallet balances,
primary keys, unique emails, and unique wallet user IDs are preserved. It adds no
foreign key, so the existing application deletion and test cleanup behavior remain
unchanged.

```sh
bun run docker:tests
bun run migration:status:tests # baseline is pending; does not create history
bun run migration:up:tests
bun run migration:status:tests # baseline is applied
bun run seed:up:tests
```

Create a versioned SQL file without connecting to a database:

```sh
bun run migration:create add-user-index
```

Use a lowercase name with hyphens. Edit the generated file in
`database/migrations/`, keeping both `-- Up Migration` and `-- Down Migration`
sections. The migrator assigns the timestamp prefix and loads SQL directly.
Only `.sql` files in that directory are considered.

| Operation                       | Development                | Validation                       |
| ------------------------------- | -------------------------- | -------------------------------- |
| Apply all pending migrations    | `bun run migration:up`     | `bun run migration:up:tests`     |
| Roll back the latest migration  | `bun run migration:down`   | `bun run migration:down:tests`   |
| List applied/pending migrations | `bun run migration:status` | `bun run migration:status:tests` |
| Load fixtures                   | `bun run seed:up`          | `bun run seed:up:tests`          |

`migration:status` replaces **both** `migration:executed` and `migration:pending`
(including their `:tests` variants). It reads `public.pgmigrations` without
modifying the database and flags history entries whose SQL file is missing.
`migration:create <name>` replaces the legacy `create --name` invocation.

To exercise rollback and reapplication on the disposable validation database:

```sh
bun run migration:down:tests
bun run migration:status:tests
bun run migration:up:tests
bun run seed:up:tests
```

Rolling back the baseline **drops users and wallets, including their data**.
With additional migrations present, each `down` rolls back only the latest one.
Reapplication is `up` after `down`; there is no separate `redo` command.

`node-pg-migrate` owns its history, transaction handling and PostgreSQL advisory
lock. All pending migrations run in a single transaction; failures roll back the
batch. Concurrent execution fails while the migrator's advisory lock is held.
The commands await completion, release connections and exit nonzero on failure.
The runner options follow the [version 9 API](https://github.com/salsita/node-pg-migrate/blob/v9.0.0/docs/src/api.md).

## Automated test databases

`bun run test:e2e` provisions its own PostgreSQL from
`docker/docker-compose.test.yml`, applies the same migrations and removes the
run's container/network afterward. It assigns a unique project, database and
loopback port, uses tmpfs instead of a persistent volume, and supplies its own
`DB_*` target. Logs and exit codes remain under `.context/test-runs/`.

The `docker:tests`, `migration:*:tests` and seed commands documented here remain
manual tools. Use `test:e2e:prepared` when intentionally testing against that
already prepared disposable target. See [developer checks](developer-checks.md#isolated-database-checks)
for the automated lifecycle and targeted commands.

## Seeds and cleanup

Run migrations before seeds. Seeds no longer apply migrations implicitly: they
load `users.seed.sql` followed by `wallets.seed.sql` using a single client and
transaction. The existing fixture is `john@gmail.com`, role `guest`, with a zero
balance wallet. A failure rolls back both files and exits nonzero; connections
close on success and failure. Fixtures are deliberately not idempotent: running
the command twice reports a duplicate key and preserves the first insertion.

Inspect persisted fixtures and history:

```sh
docker compose -p ddh -f docker/docker-compose.yml exec -T postgres-test \
  psql -U user -d ddh_tests -c 'SELECT name, run_on FROM public.pgmigrations ORDER BY id;'
docker compose -p ddh -f docker/docker-compose.yml exec -T postgres-test \
  psql -U user -d ddh_tests -c 'SELECT u.email, w.balance FROM users u JOIN wallets w ON w."userId" = u.id;'
```

Remove only the disposable validation container when finished:

```sh
docker compose -p ddh -f docker/docker-compose.yml rm --stop --force postgres-test
```

## Verification and remaining work

See [the combined issue #8 record](validation/issue-8-upgrade.md) for the database
workflow rerun on the final dependencies, and [the issue #4 operational record](validation/issue-4-database.md)
for the original migration replacement. Those records describe the earlier
manual workflow. Current hooks and automated local validation are documented in
[developer checks](developer-checks.md).

The broader modernization remains governed by [ADR 0001](adr/0001-modernize-with-bun.md).
Future objectives remain: an Nx monorepo; correcting hexagonal coupling between
domain, request context/framework and concrete event publication; and completing
startup/executable examples for CLI and messaging.

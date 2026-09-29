# Issue #4 operational verification

Executed on 2026-09-29 for [issue #4](https://github.com/danilomartinelli/vibecoding-starter-js/issues/4),
using Bun 1.4.2, node-pg-migrate 9.0.0, pg 8.23.0, Docker Compose, and
`postgres:18.6-alpine` on arm64. The server reported PostgreSQL 18.6.
Initial verification writes targeted the disposable `ddh_tests` database on
`localhost:5434`, service `ddh-postgres-test-1`. The review follow-up below used
separate disposable containers. No development or production database was migrated.

These were manual operational checks. Temporary probe migrations were removed
after rollback. No test suite, scenario, CI, hook or aggregate validation routine
was introduced.

## Installation and runtime

- `bun install --frozen-lockfile`: exit 0, including a fresh installation in a
  scratch directory containing only the manifests/lock/config; 1,079 packages
  installed. The legacy migrator is absent from the resolved tree.
- Repeated database commands with `PATH` containing only the Bun 1.4.2 executable
  and `/usr/bin:/bin`, where no Node executable was available: creation, `up`,
  `down`, `status` and seeds succeeded. The failure cases below exited 1.
- With development `.env` and validation `.env.test` both present, the resolved
  connections were respectively `localhost:5433/ddh` and
  `localhost:5434/ddh_tests`. The application and database commands share this
  port-aware configuration.

## Migrations

| Operation                                                                        | Observed result                                                                                                                     |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `bun run migration:status:tests` on the empty database                           | `pending 1790640000000-baseline`; no writes from status                                                                             |
| `bun run migration:up:tests`                                                     | Created `users`, `wallets`, and `public.pgmigrations`; one baseline history row                                                     |
| Inspect schema                                                                   | Preserved varchar IDs/fields, timezone-aware timestamps, integer balance, both primary keys, unique email and unique wallet user ID |
| `bun run migration:status:tests`                                                 | Baseline reported `applied`                                                                                                         |
| `bun run migration:down:tests`                                                   | Both domain tables absent (`to_regclass` returned NULL); history count 0                                                            |
| `bun run migration:up:tests`                                                     | Recreated the baseline and its history row                                                                                          |
| `bun run migration:create issue4-operational-probe`                              | Generated `1790691221818_issue4-operational-probe.sql` with Up/Down sections, without a database connection                         |
| Edit probe to create a table, then call a nonexistent SQL function; run `up`     | Exit 1, PostgreSQL error `42883`; probe table absent and no probe history row; baseline remained applied                            |
| Remove the failing statement; `up`, `down`, `up`, `down`                         | All exit 0; status alternated applied/pending for the probe; baseline remained applied                                              |
| Hold the migrator's exported advisory lock from a separate client, then run `up` | Exit 1: `Another migration is already running. Advisory lock mode is set to 'fail'.`                                                |
| Release the lock; run `up`                                                       | Exit 0: `No migrations to run!`                                                                                                     |

The lock-contention attempt also printed the library's `Failed to release
migration lock` warning because that attempt had never acquired the held lock.
The owning client's connection was closed, and the next migration invocation
succeeded.

## Seeds

- `bun run seed:up:tests` committed the existing `john@gmail.com` / `guest` user
  and a linked wallet with integer balance 0.
- On empty tables, temporarily required `wallets.balance > 0` and ran the same
  command: the user insert ran, the wallet insert failed with PostgreSQL `23514`,
  and the command exited 1. Both table counts remained **0**, confirming that
  the seed transaction rolled back both files. Removed the temporary constraint.
- Retrying then succeeded. A duplicate seed attempt exited 1 with `23505` and
  left exactly the original fixture pair.
- After success and failure, `pg_stat_activity` showed **0** remaining client
  connections for `ddh_tests`, excluding the inspection connection.

## Existing behavior and static checks

- Ran the existing create-user file first: **6/6 passed**.
- Ran the entire existing end-to-end suite:

  ```sh
  bun run test:e2e --modulePathIgnorePatterns '<rootDir>/.context/'
  ```

  **2 suites, 7 tests passed**: successful creation, five invalid inputs, and
  deletion, using real Nest + HTTP + PostgreSQL. The temporary CLI ignore avoids
  package-name collisions from earlier research projects inside the workspace's
  gitignored `.context`; test configuration and scenarios were not changed.
  Jest still executes on Node in this ticket. This result does not claim Bun
  application/test runtime migration or prove user/wallet atomicity in the
  application; those remain distinct from the verified seed transaction.

- `bun node_modules/typescript/bin/tsc --noEmit --incremental false --types node,jest`:
  **passed**. Without the explicit ambient type list, the existing compiler
  configuration reports `TS2688` for the deprecated transitive
  `@types/minimatch@6.0.0` stub. Broad tooling/dependency modernization is deferred;
  this is not an all-tooling-clean claim.
- ESLint on the changed TypeScript and `.mjs` commands: **passed**. For `.mjs`,
  used `--parser-options '{"project":null}'` because the existing TypeScript
  project does not include JavaScript; no lint configuration/rules were changed.
- Prettier on changed code/configuration, the database guide, this record and the
  ADR: **passed**. The whole README still has two formatting discrepancies in
  untouched architecture content; its added database instructions need no changes.
- `bun run deps:validate`: **passed**, 105 modules / 284 dependencies. The legacy
  dependency-cruiser emitted Node's `fs.R_OK` deprecation warning.
- `git diff --check`: **passed**.

The existing Nest dependency family still has its reflect-metadata peer warning;
this ticket neither upgrades the framework nor claims a clean dependency audit.
The scoped database workflow is verified independently of the remaining
modernization tickets.

## Review and cleanup

The `code-review` skill's independent Standards and Spec reviews reported **0
findings each**. Standards found no documented-rule violations or actionable
baseline smells; Spec found no missing requirements, scope creep or incorrect
implementation within issue #4. These were read-only reviews of code and recorded
evidence, not additional database test runs.

After verification, the disposable validation container was stopped and removed
with the documented service-specific cleanup command. Other project containers
and development volumes were left intact.

## PR #9 review follow-up

Reproduced and corrected both local review findings on 2026-09-29. The attached
GitHub review summary contained no additional finding.

- **Premature readiness:** workspace-only probes in `.context/debug/pr9/`
  instantiated each service from the real Compose configuration in a separate
  project, using ephemeral host ports and tmpfs instead of development storage.
  A temporary init SQL file ran `SELECT pg_sleep(6)` to make the startup race
  deterministic; the configured healthcheck interval remained unchanged.
  `python3 .context/debug/pr9/healthcheck.py postgres-test` and the equivalent
  `postgres` invocation both failed before the fix: `up --wait` exited 0,
  the socket probe exited 0, the TCP probe exited 2, and the immediately following
  `migration:up:tests` exited 1 with `Connection terminated unexpectedly`.
  The image's entrypoint confirmed that its temporary server starts with
  `listen_addresses=''`. Changing only the probe to `-h 127.0.0.1` made it wait
  for the final server. After updating both Compose healthchecks, both original
  probe invocations passed: socket and TCP probes exited 0, and the baseline
  applied immediately after `up --wait`.
- **Existing environment files:** `python3 .context/debug/pr9/env-port.py`
  loaded the old `.env.example` as `.env` in an isolated working directory,
  without shell `DB_*` overrides, through the actual shared connection config.
  Both runs failed the expected development-port check, resolving
  `localhost:5432/ddh`. Changing only `DB_PORT` to `5433` made the same check pass,
  resolving `localhost:5433/ddh`. The setup guide now explicitly requires this
  edit for existing Compose users before running the app, migrations, or seeds.
  The workspace's environment files were not edited.
- **Workflow after the fix:** the `postgres-test` probe with `--workflow` passed
  immediate baseline application, status, rollback, reapplication, and seeds.
  SQL inspection found one persisted user/wallet pair with balance 0. The
  existing Nest + HTTP + PostgreSQL suite passed: **2 suites, 7 tests**.

Compose configuration validation, scoped Prettier, and `git diff --check` passed.
Both probe projects and their disposable containers/networks were removed.
Diagnostic scripts remain only in the gitignored `.context/debug/pr9/` directory;
no permanent test suite, scenario, CI, hook, or aggregate validation routine was added.

# Issue #8: reproducible upgrade and dependency remediation

Validated on September 29, 2026 against `origin/master` at `e59baa0`, including
the merged runtime, framework and strict-tooling slices (#4–#7). Runtime:
**Bun 1.4.2** on macOS arm64; database: **PostgreSQL 18.6**.

## Implemented remediation

- Updated dotenv 16.6.1 to 18.0.4 and nanoid 3.3.19 to 6.0.1. Disabled dotenv's
  new informational banner while retaining environment-file selection and shell
  precedence; migration status continues to print only its status rows.
- Removed unused direct uuid and its old declarations. Pinned the already-current
  env-var 7.5.0, oxide.ts 1.1.0 and Node LTS declarations 24.19.0.
- Replaced Gherkin's vulnerable uuid 9/10 copies with uuid 14.0.2 through an
  explicit override. Also replaced deprecated transitive glob 10.5.0 and
  reflect-metadata 0.2.1 with 13.0.6 and 0.2.2. No audit suppression or security
  exception was requested or accepted.
- Reviewed all 42 retained direct dependencies and all 458 distinct resolved
  package/version pairs. The final registry metadata has no deprecated versions.
  The [inventory](../dependencies.md) names each consumer, compatibility decision,
  override and retained transitive helper.

Before remediation, `bun audit` exited 1 with one moderate advisory,
[GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq).
After remediation, the unfiltered command exits 0 with
`No vulnerabilities found (checked 436 packages)`. Audit package-name counts
differ from installation's package/version count. No check was unavailable and
no known dependency alert remains as of this execution.

## Clean installation and individual checks

Removed the installed tree from the repository root by moving it into ignored
local scratch space, then installed from the versioned lockfile. This was not
an incremental install. SHA-256 checks confirmed `bun.lock`, `package.json`,
`.env.test` and `.env.example` were unchanged by the frozen installation. No
development `.env` was created or modified and no `dist/` was produced.

| Executed command                                    | Actual result on final dependencies                                                              |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `bun --version`                                     | 1.4.2                                                                                            |
| `bun install --frozen-lockfile`                     | Passed; 458 packages installed from an absent `node_modules`                                     |
| `bun run typecheck`                                 | Passed; strict project checking, no emitted artifacts                                            |
| `bun run lint`                                      | Passed; zero errors and warnings                                                                 |
| `bun run format:check`                              | Passed; no formatting differences                                                                |
| `bun run deps:validate`                             | Passed; 109 modules / 299 dependencies, zero violations                                          |
| `bun run depcruise --info`                          | Passed; TypeScript 6.0.3 recognized in supported `>=2.0.0 <7.0.0` range                          |
| `PATH="/opt/homebrew/bin:$PATH" bun run deps:graph` | Passed with Graphviz 16.1.0; generated SVG kept locally and original illustrative asset restored |
| `bun test`                                          | 7 passed, 0 failed, 13 assertions across the original 2 files                                    |
| `bun audit`                                         | Passed; all dependencies included, 436 names checked, zero known vulnerabilities                 |
| `bun outdated`                                      | Only GraphQL, TypeScript and Node declarations; documented compatibility/LTS decisions           |
| `git diff --check`                                  | Passed                                                                                           |

Focused creation (6 cases) and deletion (1 case) runs also passed during
remediation. The final full suite ran after the last dependency change, using
real Nest, HTTP, PostgreSQL and the injected native Bun runner. The existing
feature files, case assertions and test infrastructure were unchanged.
`skipLibCheck` remains the previously documented third-party declaration
concession; all project sources and tooling remain strictly checked.

## Database workflow on the final tree

Used the documented `bun run docker:tests` command with the bundled
`postgres:18.6-alpine` service: owned container `ddh-postgres-test-1`, loopback
port 5434, database `ddh_tests`, temporary memory-backed storage. The service
did not exist before this work. The final run started from a newly created
container and `.env.test`, without database shell overrides.

| Step / command                                        | Observed result                                                                                |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `migration:status:tests` on the empty database        | Baseline pending; `pg_tables` showed no public tables, so status did not create history        |
| `migration:up:tests`                                  | Applied `1790640000000-baseline`                                                               |
| `migration:create issue-eight-validation-index`       | Created a timestamped SQL file with Up/Down sections                                           |
| Edited the generated file locally                     | Up created an index on `users(country)`; Down dropped that index                               |
| `migration:up:tests`, then `migration:status:tests`   | Baseline and generated migration applied; `to_regclass` confirmed the index                    |
| `migration:down:tests`                                | Rolled back only the generated migration; `to_regclass` returned null                          |
| `migration:up:tests`, then `migration:down:tests`     | Reapplied and rolled back the generated SQL successfully; file then moved out of migrations    |
| `migration:down:tests`, then `migration:status:tests` | Rolled back the baseline; status pending                                                       |
| `migration:up:tests`                                  | Reapplied the baseline                                                                         |
| `seed:up:tests`                                       | Loaded users then wallets and committed; joined query returned `john@gmail.com` with balance 0 |
| Final `bun test`                                      | Passed against that schema; existing cleanup removed the fixtures                              |

All migration/seed commands above used `bun run <command>`, executing the
existing `.mjs` entries and SQL under Bun. The temporary index migration was
only an operational exercise; it is not delivered as a schema change or test.
No application/development or production database was migrated.

## Actual application and adapter limits

`NODE_ENV=test bun run start` launched the real `src/main.ts` against the
validation database. Process inspection identified `bun src/main.ts`.
`/docs`, `/docs-json`, `/v1/users` and a GraphQL schema request all returned
HTTP 200. OpenAPI contained `/v1/users` and `/v1/users/{id}`; REST read the seeded
user; GraphQL retained `findUsers` and `create`. `start:dev` also started the real
application using `bun --watch src/main.ts` and served OpenAPI successfully.
Shutdown via SIGTERM returned the expected signal status 143; PostgreSQL then
reported zero remaining application connections. The owned validation container
was removed after validation using the documented service-specific cleanup.

CLI and messaging retain the existing registered command/handler contracts,
without a CLI bootstrap or message transport. They were reviewed, not claimed
to execute end to end. See [adapter limits](../adapters.md).

The user service still awaits its repository transaction; insertion awaits
domain publication and `emitAsync`; the wallet handler returns its insertion
promise with `suppressErrors: false`. Both repositories select the same request
transaction connection, and `finally` clears it. No transaction or adapter code
was changed for this remediation. **The seven cases do not prove atomic rollback.**
They contain no forced wallet failure. These real application results are
separate from the isolated specification probes recorded in ADR 0001. A manual
Gherkin `loadFeatures` compatibility probe also found the two existing features;
it was not counted as an application test or added as a suite.

No new scenarios, automated suites, test boundaries, CI, hooks, aggregate
validation routine, production migration or deployment were introduced.
Next objectives remain **Nx monorepo; correction of hexagonal coupling;
completion of CLI and messaging examples**.

## Standards review

The `code-review` skill reviewed implementation commit `011d8ee` against
`origin/master` in an independent Standards agent. No documented-standard
violations or baseline smells were found. The review confirmed inventory counts,
override consumers, the narrow dotenv adjustment and explicit adapter/rollback
limitations. Behavioral tests were not rerun during review.

## Spec review

A separate Spec agent found no missing requirements, scope creep or incorrect
implementations. It checked registry and execution evidence, fixed dependency
resolutions, the database workflow and retained future objectives. The eventual
PR must carry the same validation results and future objectives.

Review totals: Standards **0** findings; Spec **0** findings.

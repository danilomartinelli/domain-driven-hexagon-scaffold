# Developer checks

## Setup

Use the Bun version pinned in `.bun-version` and install ripgrep (`rg`) and
`make` on `PATH` (on macOS: `brew install ripgrep`; the Xcode command line tools
supply `make`). The bounded search helper and its pre-commit tests require
ripgrep; the workflow guardrails dry-run the Makefile. Installation runs the `prepare`
script to install Husky for this checkout. Confirm the installed tools before
the first test, formatter or Nx task:

```sh
bun --version # must match .bun-version
rg --version
make --version
bun install --frozen-lockfile
bun --bun ./node_modules/.bin/nx --version
bun --bun ./node_modules/.bin/prettier --version
```

Setup is complete when installation and all five version commands succeed;
repeat it after dependency or lockfile changes.

## Gates

Git commits run lint-staged with the
existing Prettier configuration, then `check:code` (lint, types, architecture and
core/package tests), then staged Markdown validation. When dependency manifests or Bun lockfiles are staged, the
hook also audits them against the registry. The hook runs without Docker. A
failure blocks the commit. Continuous integration runs `bun run check`,
`bun run nx run test-runner:test-broker`, `bun run test:e2e` `bun run test:component` and `bun run test:distribution` on pull
requests and pushes to `master`. All belong to the `check` job required by the
`protect-master` ruleset. The uncached broker target uses the pinned Docker image
to force the healthcheck-before-startup ordering and verifies fixture cleanup
ownership. The distributed end-to-end suite verifies the service integration and
all seven Gherkin cases through Kong, including separate GraphQL schemas and
pending Wallet/deletion behavior. CI also runs
`bun run nx run test-runner:test-gateway` for loaded upstream configuration,
foreign-target rejection, occupied proxy/Admin ports and failed Kong setup cleanup.
CI also selects `test-runner:test-preservation` when the compared commits change
anything outside documentation. This exercises the complete prepared E2E suite
while checking development and sibling environment preservation. Dispatches and
first pushes without a baseline run it conservatively. The broader runner
lifecycle suite remains in local `check:full` and includes these focused targets.

To collect evidence such as individual test names (for example the seven
Gherkin cases), run `AGENT=0 bun run check:full`: Bun's
[agent mode](https://bun.com/docs/test#ai-agent-integration) prints only
failures and totals under coding agents. Live `run-many` scripts print every
task's output, including each provisioned run's `Result:` line.

Before declaring code changes ready, run `bun run check:full` (`make check`)
with Docker running. Its scope is the suites below. Documentation-only changes
require formatting of the affected files, `bun run check:docs`, and verification
of changed commands. The focused commands below remain available during development.
The [migration evidence map](migration-evidence.md) links each delivered
requirement to the suites that exercise it.

| Check             | Command                     | Scope                                                                                                                                                                                                               |
| ----------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fast gate         | `bun run check`             | Formatting, documentation references and `check:code`                                                                                                                                                               |
| Full gate         | `bun run check:full`        | Fast gate, conditional dependency audit, runner lifecycle tests, provisioned application E2E, service component suites and isolated distribution verification                                                       |
| Types             | `bun run typecheck`         | Application, tests, runner, database scripts and tool configs; includes decorator fixture                                                                                                                           |
| Lint              | `bun run lint`              | Same code/configuration scope; errors and warnings fail                                                                                                                                                             |
| Formatting        | `bun run format:check`      | Configured source, tooling, docs and root agent guidance                                                                                                                                                            |
| Architecture      | `bun run lint:boundaries`   | Nx project ownership/cycles plus file-layer checks in `src/`, `tests/`, `scripts/` and `database/`, including type-only imports, exports and aliases; `deps:validate` is an alias                                   |
| Core and packages | `bun run test:unit`         | Every project's infrastructure-free `test` target: domain, use cases, commands, exceptions and colocated package tests                                                                                              |
| Live behavior     | `bun run test:e2e`          | Provisions isolated PostgreSQL/RabbitMQ, migrates and seeds, runs the seven original Gherkin cases and database/API regressions, cleans up                                                                          |
| Components        | `bun run test:component`    | Application targets provision isolated runs, migrate/seed only their app and check APIs/database ownership. The generator target owns a broker and scratch app to verify generated transport recovery and shutdown. |
| Distributions     | `bun run test:distribution` | Packages each service, runs it from an external directory, migrates only its owned database and verifies independent HTTP/GraphQL and messaging                                                                     |
| Runner lifecycle  | `bun run test:tooling`      | Real Docker: named environments, the `make dev`/`make down` workflow, development/sibling preservation, target guards, failure status, signals and cleanup                                                          |
| Documentation     | `bun run check:docs`        | All tracked and unignored Markdown sources; local files, images and anchors, including inbound links from unchanged documents                                                                                       |
| Dependencies      | `bun run audit:changed`     | Complete locked tree; no advisory ignores                                                                                                                                                                           |

`bun run lint:fix` and `bun run format` apply fixes. lint-staged formats all
supported staged files, including docs/skills, with `--ignore-unknown`; the
full-repository formatting command keeps the long README and vendored skills
outside its scope. For changed skills, use
`bun --bun prettier --check .agents/skills/<name>/SKILL.md`.

The infrastructure-free compatibility matrix runs in `bun run nx run e2e:test`
and `test:unit`. The distinct, uncached `bun run nx run e2e:test-compatibility`
provisions real retained-message transitions; it is also included in `test:e2e`.
See [contract evolution](contract-evolution.md) for the fixture/version evidence.

Run `bun --bun lint-staged` before capturing a staged review snapshot. If a hook
changes the committed tree, review the resulting difference before publishing.
`bun run prepare` reinstalls hooks when needed. The hook needs Bun on the Git
process's `PATH`; it invokes the installed local tools without downloading them.

## Focused feedback

After each implementation slice, run focused tests, typechecking and lint on
the changed code; resolve failures before broadening validation. Pass the actual
changed TypeScript or JavaScript paths explicitly; for example:

```sh
bun test ./scripts/tests/search.test.ts &&
  bun run nx run test-runner:typecheck &&
  bun --bun eslint scripts/search.ts scripts/lib/read-ranges.ts scripts/tests/search.test.ts --max-warnings 0
```

When adding or changing an Nx target, or a test that invokes Nx, also run the
actual target with `bun run nx run <project>:<target> --skip-nx-cache` before
staged review. Direct Bun invocations are useful for the inner loop but do not
exercise the task environment inherited from Nx. Use
[nx-run-tasks](../.agents/skills/nx-run-tasks/SKILL.md) to select the target.

Changes to Nx targets, project dependencies or shared workspace fixtures also
require `bun run nx run test-runner:test-nx-runner` before staged review. This
uncached regression executes affected application components under a shared Nx
parent and verifies that their migrations can run independently. CI runs the
same target before environment-preservation and distributed suites.

Infrastructure and runner changes also affect the applications' component
fixtures. Before staged review, select and run the affected `test-component`
targets through Nx. Supply the actual changed paths, including staged and new
files; for a Compose change:

```sh
bun run nx show projects --affected --files=scripts/lib/compose.ts --with-target=test-component --json
bun run nx affected --target=test-component --files=scripts/lib/compose.ts
```

The component targets keep their owned environment wrappers. For changes to
provisioning or cleanup, add the matching focused lifecycle target
(`test-broker`, `test-gateway`, `test-preservation` or `test-nx-runner`) and the
changed lifecycle tests by name; component tests alone do not cover those
failures:

```sh
bun test ./scripts/tests/environment.test.ts --test-name-pattern 'development workflow'
```

The complete `test:tooling` suite belongs to the full gate. This focused feedback
precedes the full gate and does not replace it.

When changing application behavior, E2E coverage or runner code, run
`bun run nx run test-runner:test-preservation` before staged review. This test
executes the complete prepared E2E suite, so adding tests can affect its deadline
even when provisioning code is unchanged. `bun scripts/preservation-required.ts`
shows whether branch, staged, unstaged or new files require it; `--base` and
`--head` select immutable commits for CI. Git comparison failures fail the command.

Use `&&` to stop a sequential batch on failure. For independent checks, use
separate tool calls (parallel when useful) and inspect every command's exit
status. A batch is successful only if every check passed; `;` or unchecked
parallel results can hide an earlier failure behind the last command's success.
When saving logs, preserve the check's status and read the log in a separate
call; a successful log reader is not evidence that the check passed.
Long nested preservation runs report their deadline, elapsed time, time since
last output and the existing `run.log` path every 30 seconds. Timeout diagnostics
name the command label and budget; arguments and environment values are omitted.

Once focused checks pass, stage and format the intended changes, then complete
both staged reviews and resolve their findings. Run the full gate above only
after the final reviewed snapshot is ready. Changes after that gate require
affected checks, another review and final validation of the new snapshot.
Operational guides describe test coverage without copying execution totals,
so adding a regression does not
require updating those guides unless the coverage changes.

## Nx orchestration

Package scripts delegate to Nx targets; see [the workspace guide](nx-workspace.md)
for projects, private exports, absent suites and cache inputs. Shared
quality settings live in `tooling/config`, with native root entry points for
editors. The compile-time fixture is `src/type-tests/final.decorator.ts`.
`test:debug` opens the User application unit suite; every other suite has its
own `test-debug` target. Live targets always execute.

## Isolated database checks

Start Docker and run `bun run test:e2e`; no environment file is required.
It creates a unique workspace/run configuration with PostgreSQL, RabbitMQ and Kong,
applies migrations and seeds explicitly, runs the suite, and shuts down its
owned containers and network. Tests use tmpfs; no volumes are deleted.
Explicit shell values are preserved, but unsafe test target overrides fail
before opening connections. All live Nx targets have `cache: false`.

```sh
bun run test:e2e --test-name-pattern 'Wallet persistence failure'
bun scripts/with-test-database.ts -- bun test --preload ./tests/setup/preload.ts ./tests/user/create-user/create-user.test.ts
```

For the separate preparation, selected-app migration/seed, targeted test and
shutdown commands, see [the database workflow](database.md). The same guide
explains environment precedence, resource ownership, lifecycle deadlines and
reserved gateway configuration. Logs, manifests and result statuses remain
under `.context/test-runs/<project>/`; each run ends with a `Result:` line.

To show that tests describe behavior that existed before a change, run them
against the base commit (the merge-base with `origin/master`, or `--base <ref>`):

```sh
bun run characterize -- tests/integration/find-users.test.ts
```

It copies the named files into a temporary worktree of the base, installs its
locked dependencies and runs the named `*.test.ts` files there with a deadline.
By default (`--runner=auto`), files under `tests/` use the provisioned runner and
application component tests use their application runner and preload. Other
paths use native Bun tests; automatic mode rejects mixed suites. For tests that
need no infrastructure or preload, use `--runner=native` to run native Bun tests
regardless of path, including mixed paths:

```sh
bun run characterize -- --runner=native \
  tests/compatibility/contracts.test.ts \
  tests/compatibility/fixtures/baseline-consumer.ts \
  tests/compatibility/fixtures/additive-consumer.ts \
  tests/compatibility/fixtures/additive-producer.ts \
  tests/compatibility/fixtures/user-created-v1.json
```

Pass every new fixture needed by the selected tests as a named file. Provisioned
runner records are kept beside
the output log in `.context/characterize/<commit>-<id>/`. It prints one result
line and removes the worktree, including after interruption, unless the
provisioned run reports a cleanup failure; then it keeps the worktree to shut
that run down.

`test:tooling` proves that independently named runs cannot redirect cleanup to
each other's targets, development seeds survive all seven Gherkin cases plus
the database regressions, development volumes survive restart, occupied Docker
ports cause owned cleanup, and failure/signal statuses are preserved. Its
unique development fixtures deliberately retain their volumes after shutdown.
Its regression run checks per-file `bun test` headers, which
[agent mode](https://bun.com/docs/test#ai-agent-integration) (for example
`CLAUDECODE=1`) omits, so it sets `AGENT=0`. On Bun 1.4.2 that value takes
precedence over agent detection; this precedence is verified, not documented.
The infrastructure-free workspace checks also exercise direct test/migration/seed
refusal without an owned manifest and Bun's shell/file environment precedence.

## Reference

The [quality reference](quality-reference.md) holds the background contracts behind
these gates: documentation reference checks, workspace and dependency guardrails,
compatible tooling versions, type and lint contracts, and architecture rules.

Run every applicable check above, including the live suite, before declaring code
ready. `bun run test`, `test:unit`, `test:watch` and `test:cov` run every project's
unit suite. `test:debug` runs only User unit tests; use
`bun run nx run <project>:test-debug` for another suite. Bare `bun test` retains its
`src/packages/core/tests` default. The E2E preload is opt-in via the live commands. Nx orchestrates this baseline.

Migration progress is tracked in [ADR 0002's implementation status](adr/0002-adopt-nx-with-nest-and-bun.md#implementation-status)
and its acceptance evidence in the [migration evidence map](migration-evidence.md).
See the [dependency inventory](dependencies.md) for version decisions and security overrides.

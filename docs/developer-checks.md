# Developer checks

## Setup

Use the Bun version pinned in `.bun-version` and install ripgrep (`rg`) on
`PATH` (on macOS: `brew install ripgrep`). The bounded search helper and its
pre-commit tests require ripgrep. Installation runs the `prepare`
script to install Husky for this checkout. Confirm the installed tools before
the first test, formatter or Nx task:

```sh
bun --version # must match .bun-version
rg --version
bun install --frozen-lockfile
bun --bun ./node_modules/.bin/nx --version
bun --bun ./node_modules/.bin/prettier --version
```

Setup is complete when installation and all four version commands succeed;
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

Before declaring code changes ready, run `bun run check:full`. Its current scope
is the suites below; future suites are added
with their migration slices. Documentation-only changes require formatting of
the affected files, `bun run check:docs`, and verification of changed commands.

| Check             | Command                     | Scope                                                                                                                                                                                               |
| ----------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fast gate         | `bun run check`             | Formatting, documentation references and `check:code`                                                                                                                                               |
| Full gate         | `bun run check:full`        | Fast gate, conditional dependency audit, runner lifecycle tests, provisioned application E2E, service component suites and isolated distribution verification                                       |
| Types             | `bun run typecheck`         | Application, tests, runner, database scripts and tool configs; includes decorator fixture                                                                                                           |
| Lint              | `bun run lint`              | Same code/configuration scope; errors and warnings fail                                                                                                                                             |
| Formatting        | `bun run format:check`      | Configured source, tooling, docs and root agent guidance                                                                                                                                            |
| Architecture      | `bun run lint:boundaries`   | Nx project ownership/cycles plus file-layer checks in `src/`, `tests/`, `scripts/` and `database/`, including type-only imports, exports and aliases; `deps:validate` is an alias                   |
| Core and packages | `bun run test:unit`         | Every project's infrastructure-free `test` target: domain, use cases, commands, exceptions and colocated package tests                                                                              |
| Live behavior     | `bun run test:e2e`          | Provisions isolated PostgreSQL/RabbitMQ, migrates and seeds, runs the seven original Gherkin cases and database/API regressions, cleans up                                                          |
| Components        | `bun run test:component`    | Each application's `test-component` target: provisions an isolated run, migrates/seeds only that application, starts it without sibling services, checks its APIs and database ownership, cleans up |
| Distributions     | `bun run test:distribution` | Packages each service, runs it from an external directory, migrates only its owned database and verifies independent HTTP/GraphQL and messaging                                                     |
| Runner lifecycle  | `bun run test:tooling`      | Real Docker: named environments, development/sibling preservation, target guards, failure status, signals and cleanup                                                                               |
| Documentation     | `bun run check:docs`        | All tracked and unignored Markdown sources; local files, images and anchors, including inbound links from unchanged documents                                                                       |
| Dependencies      | `bun run audit:changed`     | Complete locked tree; no advisory ignores                                                                                                                                                           |

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

Infrastructure and runner changes also affect the applications' component
fixtures. Before staged review, select and run the affected `test-component`
targets through Nx. Supply the actual changed paths, including staged and new
files; for a Compose change:

```sh
bun run nx show projects --affected --files=scripts/lib/compose.ts --with-target=test-component --json
bun run nx affected --target=test-component --files=scripts/lib/compose.ts
```

The component targets keep their owned environment wrappers. Add the applicable
runner/gateway lifecycle target for changes to provisioning or cleanup; component
tests alone do not cover those failures. This focused feedback precedes the full
gate and does not replace it.

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

## Documentation references

`check:docs` parses Markdown with [Bun's Markdown API](https://bun.com/docs/runtime/markdown)
and derives heading anchors with [github-slugger](https://github.com/Flet/github-slugger),
including Unicode and duplicate headings. It checks relative/root-relative links,
images, reference-style links and explicit HTML anchors. Code examples and
external URLs are outside the local reference check; it makes no network requests.
A link to a non-Markdown file checks file existence, not that format's fragments.

The hook runs `bun run check:docs --staged` against an immutable Git index tree.
Unstaged fixes cannot hide a broken staged link. Normal runs include new,
unignored Markdown files and check incoming references when a target changes.
Failures identify the source, destination and missing file/anchor; exit 1 means
documentation errors and exit 2 means the checker could not complete.

The same check validates that every root package script invoking Nx is listed
in the Commands table in `docs/nx-workspace.md`. A documented `*` covers one
colon-delimited script-name segment. Both the manifest and guide come from the
selected working tree or immutable index snapshot, so unstaged edits cannot
hide missing command documentation in a commit.

Infrastructure test fixtures use `withCleanup` from `scripts/tests/cleanup.ts`.
It attempts every registered cleanup after success or failure, preserves a lone
error's identity, and reports multiple failures together in an `AggregateError`.
ESLint rejects `await` inside `finally` in application component tests, `tests/`
integration fixtures and the Docker lifecycle suites
(`scripts/tests/environment.test.ts` and `scripts/tests/test-database-runner.test.ts`).
Register independent cleanups separately; they run concurrently. Nest
`withCleanup` calls when cleanup order matters.

## Nx orchestration

Package scripts delegate to Nx targets; see [the workspace guide](nx-workspace.md)
for projects, private exports, absent suites and cache inputs. Shared
quality settings live in `tooling/config`, with native root entry points for
editors. The compile-time fixture is `src/type-tests/final.decorator.ts`.
`test:debug` opens the User application unit suite; every other suite has its
own `test-debug` target. Live targets always execute.

## Workspace and dependency guardrails

`bun run check:workspace` starts directly with Bun, before any Nx command in
`check:code`, `check` or `check:full`. It exercises the supported Nx CLI in a
unique temporary workspace, checks real project edges and warms typecheck's
cache before introducing invalid dependency source, shared TypeScript settings
and decorator-fixture types. Each mutation must fail, and restored source must
pass. Installed external tools are shared; workspace package links and Nx cache
paths point into the temporary copy. The checkout and its cache remain untouched.

Subprocesses have a deadline and a default output limit of 64,000 characters per
stream. Git file inventories retain their complete output so repository or branch
growth cannot truncate the files being checked. Timeout kills the owned process
group; other commands fail explicitly on output overflow rather than treating
truncated output as a successful result. Test fixtures remove their temporary
directories in `finally`. The guardrail suite also tests the audit CLI with real Git and Bun
against a local HTTP registry fixture, with no external registry or Docker.
The existing real-Docker runner suite remains `test:tooling`. Its focused broker
and gateway subsets are available as `bun run nx run test-runner:test-broker`
and `bun run nx run test-runner:test-gateway`; both run in CI.

`bun run audit:changed` compares dependency files against the merge-base of
`HEAD` and `origin/master`, including branch commits, staged/unstaged changes and
untracked manifests. Use `--base <ref>` for another comparison. It runs during
`check:full`. The hook uses `bun run audit:changed --staged`, considering only the
pending commit. All `package.json`, `bun.lock` and `bun.lockb` paths are covered.
Documentation-only changes skip the registry. Dependency changes always query
it; there is no Nx target or cached audit result. `bun audit` remains the command
for an unconditional manual audit.

Audit status is explicit: `audit:clean` or `audit:skipped` returns 0,
`audit:vulnerable` returns 1, and `audit:unavailable` returns 2 for registry,
timeout, invalid-report or Git-comparison failures. An unavailable comparison
base never becomes a skipped/successful audit. Staged dependency files must
match their working copies; mixed staged/unstaged dependency edits fail before
querying, so a different lockfile cannot validate the pending commit. Registry
queries are bounded to 60 seconds and include development dependencies.

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

## Compatible tooling

The registry and the [typescript-eslint support matrix](https://typescript-eslint.io/users/dependency-versions/)
were rechecked on September 29, 2026:

| Tool                  | Selected version | Compatibility decision                                                                                   |
| --------------------- | ---------------- | -------------------------------------------------------------------------------------------------------- |
| TypeScript            | 6.0.3            | Maintained 6.x, inside typescript-eslint's `>=4.8.4 <6.1.0`; registry latest 7.0.2 is outside that range |
| ESLint / `@eslint/js` | 10.11.0 / 10.0.1 | ESLint 10 is supported by typescript-eslint 8.71.0                                                       |
| typescript-eslint     | 8.71.0           | Flat `strictTypeChecked` preset with the TypeScript project service                                      |
| Prettier              | 3.9.9            | Independent formatter; no eslint-plugin-prettier or ESLint formatting rules                              |
| dependency-cruiser    | 18.4.0           | ESM config, TypeScript 6 and Bun export conditions                                                       |
| Supertest / its types | 7.3.0 / 7.2.1    | Current HTTP test client and matching agent signature                                                    |
| pg types              | 8.23.1           | Typed migration-history queries for pg 8.23.0                                                            |
| Jest types            | 30.0.0           | Declarations for jest-cucumber's injected runner interface; no Jest runtime                              |

Tools execute under Bun using the individual scripts. dependency-cruiser uses
an explicit local executable path to avoid colliding with the `depcruise` script
name. The upstream CLI engine declarations target Node (ESLint supports Node
24; dependency-cruiser supports Node 22/24/26); this repository validates their
execution on its selected Bun 1.4.2 runtime.

## Type and lint contracts

`strict: true` and `noEmit: true` apply throughout the project. The old overrides
for implicit `any`, property initialization and `bind`/`call`/`apply` have been
removed. JavaScript tooling is included using `allowJs`/`checkJs`; database rows
have JSDoc result contracts. Casing and switch fallthrough checks are enabled.
The Bun module/decorator configuration and field-assignment semantics remain.

`skipLibCheck` remains limited to third-party declarations. Checking dependency
internals currently exposes missing optional Nest gateway/AST packages and
Bun ambient declaration conflicts. It does not exclude project code or tooling
from strict checking. DTO definite-assignment declarations describe fields
populated by Nest, mappers or inherited constructors, without adding defaults
that could change validation or responses.

The lint preset is used without global rule overrides or ignored source files.
Infrastructure fixtures use `withCleanup` to retain operation and cleanup
failures. Standalone Docker probes use `removeOwnedContainer` from
`scripts/tests/owned-container.ts`: it verifies `dev.starter.owner`, removes the
inspected container ID without volumes, and treats only a confirmed absent name
as already cleaned. ESLint rejects direct literal Docker container-removal
commands (argument arrays and shell calls) outside that helper in test fixtures.
Computed commands still require ownership review.

Three local, explained directives retain constructs required by the examples:
two empty Nest module classes and the public query marker base. Wallet creation
now records its `userId` as part of the domain fact. Unsafe file-wide suppressions in
the conversion and decorator helpers have been removed.

## Architecture

`workspace:boundaries` combines the resolved Nx project graph with
dependency-cruiser's file graph. The repository-owned Nx checker rejects imports
of app implementation, nontechnical shared dependencies, invalid core/contract
dependencies and project cycles, including manifest and implicit edges. The
[workspace guide](nx-workspace.md#executable-boundaries) documents the ownership
matrix and diagrams.

`.dependency-cruiser.mjs` closes the import graph of shared DDD, exceptions,
foundation helpers, User/Wallet domain, User and Wallet use cases, their ports and command inputs to plain core modules
and `oxide.ts`. This includes type-only imports and paths through barrel exports.
API adapters and CQRS handlers may not import an application's `database/` persistence models or repositories.
Applications under `src/apps` import only their own files and shared package entry points;
nothing else imports their implementation, and their production code cannot import database tooling.
`check:workspace` injects representative violations into a temporary copy
(core/command inputs to Nest, Slonik, RabbitMQ or ambient context, adapter to
persistence, handler to API DTO, type-only cycles, private/unexported package
paths, test-helper aliases, cross-app imports and shared-barrel bypasses) and
requires each to fail under its rule name. The legal graph passes before and
after restoration. Declared Nx edges are also mutated after warming the cache.
The domain request-context exception is removed. New packages follow
[the deep-module convention](../src/packages/AGENTS.md): root files are public
entry points, all subfolders are private, tests use entry points and their own
fixtures, and dependency cycles are errors throughout the checked graph. `type-fixtures` owns compile-time fixtures; `wallet` owns
`src/apps/wallet` and `user` owns `src/apps/user`; private technical packages now live under `src/packages`.
Type-only adapter imports from development declarations
are permitted while runtime development-only dependencies remain forbidden.
The outdated classification of all `async_hooks` exports as deprecated was
removed: [AsyncLocalStorage is stable](https://nodejs.org/api/async_context.html#class-asynclocalstorage).

`bun run depcruise --info` reports analyzer capabilities. `bun run deps:graph`
regenerates `assets/dependency-graph.svg`. It checks `dot -V` for each executable
named `dot` on PATH and uses the first that identifies itself as Graphviz.
Set `GRAPHVIZ_DOT` to an explicit executable path to override discovery; an invalid
override fails. Analysis and rendering have separate checked exit statuses and
30-second deadlines. The SVG is replaced atomically only after both succeed and
produce SVG output; failures preserve the previous graph and remove temporary
files. Graphviz is needed for manual rendering, while `check:workspace` exercises
the CLI with controlled executable fixtures, including a shadowed `dot`, analyzer
and renderer failures. Both graph commands use the same ESM configuration.

Run every applicable check above, including the live suite, before declaring code
ready. `bun run test`, `test:unit`, `test:watch` and `test:cov` run every project's
unit suite. `test:debug` runs only User unit tests; use
`bun run nx run <project>:test-debug` for another suite. Bare `bun test` retains its
`src/packages/core/tests` default. The E2E preload is opt-in via the live commands. Nx orchestrates this baseline.

Migration progress is tracked in [ADR 0002's implementation status](adr/0002-adopt-nx-with-nest-and-bun.md#implementation-status).
See the [dependency inventory](dependencies.md) for version decisions and security overrides.

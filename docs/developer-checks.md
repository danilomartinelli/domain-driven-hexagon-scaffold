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
failure blocks the commit.

Before declaring code changes ready, run `bun run check:full`. Its current scope
is the suites below; future service, contract and distribution suites are added
with their migration slices. Documentation-only changes require formatting of
the affected files, `bun run check:docs`, and verification of changed commands.

| Check             | Command                   | Scope                                                                                                                                      |
| ----------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Fast gate         | `bun run check`           | Formatting, documentation references and `check:code`                                                                                      |
| Full gate         | `bun run check:full`      | Fast gate, conditional dependency audit, runner lifecycle tests and provisioned application E2E                                            |
| Types             | `bun run typecheck`       | Application, tests, runner, database scripts and tool configs; includes decorator fixture                                                  |
| Lint              | `bun run lint`            | Same code/configuration scope; errors and warnings fail                                                                                    |
| Formatting        | `bun run format:check`    | Configured source, tooling, docs and root agent guidance                                                                                   |
| Architecture      | `bun run lint:boundaries` | `src/`, `tests/`, `scripts/` and `database/`, including type-only imports and aliases; `deps:validate` is an alias                         |
| Core and packages | `bun run test:unit`       | Infrastructure-free User/Wallet domain, commands, exceptions and colocated package tests                                                   |
| Live behavior     | `bun run test:e2e`        | Provisions isolated PostgreSQL/RabbitMQ, migrates and seeds, runs the seven original Gherkin cases and database/API regressions, cleans up |
| Runner lifecycle  | `bun run test:tooling`    | Real Docker: named environments, development/sibling preservation, target guards, failure status, signals and cleanup                      |
| Documentation     | `bun run check:docs`      | All tracked and unignored Markdown sources; local files, images and anchors, including inbound links from unchanged documents              |
| Dependencies      | `bun run audit:changed`   | Complete locked tree; no advisory ignores                                                                                                  |

`bun run lint:fix` and `bun run format` apply fixes. lint-staged formats all
supported staged files, including docs/skills, with `--ignore-unknown`; the
full-repository formatting command keeps the long README and vendored skills
outside its scope. For changed skills, use
`bun --bun prettier --check .agents/skills/<name>/SKILL.md`.

Run `bun --bun lint-staged` before capturing a staged review snapshot. If a hook
changes the committed tree, review the resulting difference before publishing.
`bun run prepare` reinstalls hooks when needed. The hook needs Bun on the Git
process's `PATH`; it invokes the installed local tools without downloading them.

## Focused feedback

After each implementation slice, run focused tests, typechecking and lint on
the changed code; resolve failures before broadening validation. Pass the actual
changed TypeScript or JavaScript paths explicitly; for example:

```sh
bun --bun eslint scripts/search.ts scripts/lib/read-ranges.ts scripts/tests/search.test.ts --max-warnings 0
```

Use the full gate above for final validation. Record exact test totals in the
dated execution records under `docs/validation/`; operational guides describe
coverage so adding a regression does not require updating copied totals.

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
broken references and exit 2 means the checker could not complete.

Infrastructure test fixtures use `withCleanup` from `scripts/tests/cleanup.ts`.
It attempts every registered cleanup after success or failure, preserves a lone
error's identity, and reports multiple failures together in an `AggregateError`.

## Nx orchestration

Package scripts delegate to Nx targets; see [the workspace guide](nx-workspace.md)
for all ten projects, private exports, absent suites and cache inputs. Shared
quality settings live in `tooling/config`, with native root entry points for
editors. The compile-time fixture is `src/type-tests/final.decorator.ts`.
`test:unit` runs the existing application, core primitive and example suites.
`test:debug` opens the application unit suite; package inspector targets are
`core:test-debug` and `example:test-debug`. Live targets always execute.

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
The existing real-Docker runner suite remains `test:tooling`.

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
It creates a unique workspace/run configuration with PostgreSQL and RabbitMQ,
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
under `.context/test-runs/<project>/`.

`test:tooling` proves that independently named runs cannot redirect cleanup to
each other's targets, development seeds survive all seven Gherkin cases plus
the database regressions, development volumes survive restart, occupied Docker
ports cause owned cleanup, and failure/signal statuses are preserved. Its
unique development fixtures deliberately retain their volumes after shutdown.
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
Three local, explained directives retain constructs required by the examples:
two empty Nest module classes and the public query marker base. Wallet creation
now records its `userId` as part of the domain fact. Unsafe file-wide suppressions in
the conversion and decorator helpers have been removed.

## Architecture and deferred work

`.dependency-cruiser.mjs` closes the import graph of shared DDD, exceptions,
foundation helpers, User/Wallet domain, User write use cases and command inputs to plain core modules
and `oxide.ts`. This includes type-only imports and paths through barrel exports.
The domain request-context exception is removed. New packages follow
[the deep-module convention](../src/packages/AGENTS.md): root files are public
entry points, all subfolders are private, tests use entry points and their own
fixtures, and dependency cycles are errors throughout the checked graph. The transitional `legacy-app` still owns `src/modules`; private technical
packages now live under `src/packages`.
Type-only adapter imports from development declarations
are permitted while runtime development-only dependencies remain forbidden.
The outdated classification of all `async_hooks` exports as deprecated was
removed: [AsyncLocalStorage is stable](https://nodejs.org/api/async_context.html#class-asynclocalstorage).

`bun run depcruise --info` reports analyzer capabilities. `bun run deps:graph`
regenerates `assets/dependency-graph.svg` and requires Graphviz's `dot` executable.
Ensure `dot -V` identifies Graphviz, not an unrelated executable with the same
name. Both commands use the same ESM architecture configuration.

Run every applicable check above, including the live suite, before declaring code
ready. `bun run test`, `test:unit`, `test:watch` and `test:cov` include
`src/tests` and colocated tests under `src/packages`. `test:debug` runs only
`src/tests`; use `bun run nx run core:test-debug` or
`bun run nx run example:test-debug` for package suites. Bare `bun test` retains its
`src/tests` default. The E2E preload is opt-in via the live commands. Nx orchestrates this baseline;
independent service and contract/distribution suites belong to later tickets in
[the migration](adr/0002-adopt-nx-with-nest-and-bun.md).

The remaining objectives are independent applications, application-owned read ports and durable
service integration. See the
[dependency inventory](dependencies.md) for version decisions and security overrides,
and the [combined issue #8 execution record](validation/issue-8-upgrade.md) for
final validation. The [issue #7 record](validation/issue-7-checks.md) retains the
historical diagnostics and audit finding before remediation.

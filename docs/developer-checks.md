# Developer checks

Use **Bun 1.4.2** and install with `bun install --frozen-lockfile`. The `prepare`
script installs Husky for this checkout. Git commits run lint-staged with the
existing Prettier configuration, then `check:code` (lint, types, architecture and
core/package tests). The hook runs without Docker. A failure blocks the commit.

Before declaring code changes ready, run `bun run check:full`. Its current scope
is the suites below; future service, contract and distribution suites are added
with their migration slices. Documentation-only changes require formatting of
the affected files and verification of changed links/commands.

| Check             | Command                   | Scope                                                                                                         |
| ----------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Fast gate         | `bun run check`           | Formatting plus `check:code`                                                                                  |
| Full gate         | `bun run check:full`      | Fast gate, runner lifecycle tests and provisioned application E2E                                             |
| Types             | `bun run typecheck`       | Application, tests, runner, database scripts and tool configs; includes decorator fixture                     |
| Lint              | `bun run lint`            | Same code/configuration scope; errors and warnings fail                                                       |
| Formatting        | `bun run format:check`    | Configured source, tooling, docs and root agent guidance                                                      |
| Architecture      | `bun run lint:boundaries` | `src/`, `tests/` and `scripts/`, including type-only imports and aliases; `deps:validate` is an alias         |
| Core and packages | `bun run test:unit`       | Infrastructure-free User/Wallet domain, commands, exceptions and colocated package tests                      |
| Live behavior     | `bun run test:e2e`        | Provisions its own PostgreSQL, migrates, runs seven Gherkin cases and four integration regressions, cleans up |
| Runner lifecycle  | `bun run test:tooling`    | Real Docker: concurrent isolation, failure status, signal handling and cleanup                                |
| Dependencies      | `bun audit`               | Complete locked tree; no advisory ignores                                                                     |

`bun run lint:fix` and `bun run format` apply fixes. lint-staged formats all
supported staged files, including docs/skills, with `--ignore-unknown`; the
full-repository formatting command keeps the long README and vendored skills
outside its scope. For changed skills, use
`bun --bun prettier --check .agents/skills/<name>/SKILL.md`.

Run `bun --bun lint-staged` before capturing a staged review snapshot. If a hook
changes the committed tree, review the resulting difference before publishing.
`bun run prepare` reinstalls hooks when needed. The hook needs Bun on the Git
process's `PATH`; it invokes the installed local tools without downloading them.

## Isolated database checks

Start Docker and run `bun run test:e2e`; no manual database setup or environment
file is needed. Each invocation uses a unique Compose project, database name,
loopback port and tmpfs storage. It supplies its own `DB_*` values even when the
shell contains development settings. Existing environment files and volumes are
untouched. Separate wrapper invocations can run concurrently; cases within one
application suite share a database and run sequentially.

The wrapper writes subprocess output directly to the terminal and
`.context/test-runs/<project>/run.log`. `result.json` records command, cleanup and
final exit codes. It preserves failures after logging and cleanup; cleanup
failure turns a successful run into a failure. SIGINT/SIGTERM trigger bounded
child termination and cleanup, returning 130/143. Startup and migrations are
bounded to 60 seconds each, the command to five minutes, and cleanup to 30 seconds
(with five seconds for forced termination). Forced process/daemon termination
can still prevent cleanup; the retained project name identifies the owned
resources for inspection.

Focused runs use the same provisioning:

```sh
bun run test:e2e --test-name-pattern 'Wallet persistence failure'
bun scripts/with-test-database.ts -- bun test --preload ./tests/setup/preload.ts ./tests/user/create-user/create-user.test.ts
```

`bun run test:e2e:prepared` remains available for an already provisioned disposable
database. Only this manual mode uses caller-supplied `DB_*` values and requires
explicit migration/cleanup. See [runtime](runtime.md) and [database](database.md).

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
foundation helpers, User/Wallet domain and command inputs to plain core modules
and `oxide.ts`. This includes type-only imports and paths through barrel exports.
The domain request-context exception is removed. New packages follow
[the deep-module convention](../src/packages/README.md): root files are public
entry points, all subfolders are private, tests use entry points and their own
fixtures, and dependency cycles are errors throughout the checked graph. The
existing `src/modules` layout stays in place until the planned Nx migration.
Type-only adapter imports from development declarations
are permitted while runtime development-only dependencies remain forbidden.
The outdated classification of all `async_hooks` exports as deprecated was
removed: [AsyncLocalStorage is stable](https://nodejs.org/api/async_context.html#class-asynclocalstorage).

`bun run depcruise --info` reports analyzer capabilities. `bun run deps:graph`
regenerates `assets/dependency-graph.svg` and requires Graphviz's `dot` executable.
Ensure `dot -V` identifies Graphviz, not an unrelated executable with the same
name. Both commands use the same ESM architecture configuration.

Run every applicable check above, including the live suite, before declaring code
ready. `bun run test`, `test:unit`, `test:watch`, `test:cov` and `test:debug` include
`tests/unit` and colocated tests under `src/packages`. Bare `bun test` retains its
`tests/unit` default. The E2E preload is opt-in via the live commands. Nx orchestration and independent
service suites belong to later tickets in [the migration](adr/0002-adopt-nx-with-nest-and-bun.md).

The remaining objectives are Nx, application-owned ports/transactions and durable
service integration. See the
[dependency inventory](dependencies.md) for version decisions and security overrides,
and the [combined issue #8 execution record](validation/issue-8-upgrade.md) for
final validation. The [issue #7 record](validation/issue-7-checks.md) retains the
historical diagnostics and audit finding before remediation.

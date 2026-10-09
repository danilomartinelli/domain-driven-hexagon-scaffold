# Quality reference

Background contracts behind the [developer checks](developer-checks.md). Read the
section that matches the check you are changing or diagnosing.

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

## Workspace and dependency guardrails

`bun run check:workspace` starts directly with Bun, before any Nx command in
`check:code`, `check` or `check:full`. It exercises the supported Nx CLI in a
unique temporary workspace, checks real project edges and warms typecheck's
cache before introducing invalid dependency source, shared TypeScript settings
and decorator-fixture types. It likewise warms lint and unit-test caches before
changing the shared ESLint configuration and adding a failing project test.
Each mutation must fail, and restored source must pass. Installed external tools are shared; workspace package links and Nx cache
paths point into the temporary copy. The checkout and its cache remain untouched.

Subprocesses have a deadline and a default output limit of 64,000 characters per
stream. Git file inventories retain their complete output so repository or branch
growth cannot truncate the files being checked. Timeout kills the owned process
group; other commands fail explicitly on output overflow rather than treating
truncated output as a successful result. Test fixtures remove their temporary
directories in `finally`. The guardrail suite also tests the audit CLI with real Git and Bun
against a local HTTP registry fixture, with no external registry or Docker.
Its workflow checks run `make -n` to confirm each Makefile alias delegates to
one package script, follow `check` and `check:full` to every required suite,
keep the hook on `check:light` without Docker or workspace mutation suites,
and read Nx's resolved targets to enforce the
[cache contract](nx-workspace.md#cache-contract) and non-empty suites: native
suites for applications, shared cores and contracts, plus each component, system,
distribution and runner lifecycle suite that `run-many` would otherwise skip
silently if its target disappeared. Editor tasks must name existing scripts.
The existing real-Docker runner suite remains `test:tooling`. Its focused broker
and gateway subsets are available as `bun run nx run test-runner:test-broker`
and `bun run nx run test-runner:test-gateway`; both remain part of the on-demand
local lifecycle gate.

`bun run audit:changed` compares dependency files against the merge-base of
`HEAD` and `origin/master`, including branch commits, staged/unstaged changes and
untracked manifests. Use `--base <ref>` for another comparison. It runs during
`check:full`. The light gate run by the hook uses `bun run audit:changed --staged`, considering only the
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

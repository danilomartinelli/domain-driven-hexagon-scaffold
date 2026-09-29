# Developer checks

Use **Bun 1.4.2** from the repository root and install the committed dependency
set with `bun install --frozen-lockfile`. Each check is independent. No CI, Git
hooks or aggregate validation command is installed.

| Check         | Command                 | Scope                                                                                                             |
| ------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Types         | `bun run typecheck`     | Application, tests, database `.mjs` scripts, ESLint and architecture configs                                      |
| Lint          | `bun run lint`          | Same code/configuration scope; errors and warnings fail                                                           |
| Formatting    | `bun run format:check`  | Application/tests, database scripts, tool configs, package/TypeScript JSON, Docker/test YAML and `docs/` Markdown |
| Architecture  | `bun run deps:validate` | `src/`, including type-only imports and aliases                                                                   |
| Core          | `bun test`              | Infrastructure-free User/Wallet domain, commands and exceptions                                                   |
| Live behavior | `bun run test:e2e`      | Seven original Gherkin cases and four real PostgreSQL regressions                                                 |
| Dependencies  | `bun audit`             | Complete locked tree, including development packages; no advisory ignores                                         |

`bun run lint:fix` applies available lint fixes. `bun run format` writes Prettier
formatting. Lint itself never rewrites files, and Prettier runs separately from
ESLint. The long conceptual README and vendored agent skills are outside the
formatting command's scope.

Before behavioral checks, prepare a **disposable** test database:

```sh
bun run docker:tests
bun run migration:up:tests
bun run test:e2e
```

No seed is required. Run only one test process against each database because
setup and teardown truncate application tables. See [runtime](runtime.md) and
[database](database.md) for environment overrides, cleanup and individual test files.

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
The domain request-context exception is removed. The broader application/service
boundaries and circular-dependency cleanup remain later migration work. Type-only adapter imports from development declarations
are permitted while runtime development-only dependencies remain forbidden.
The outdated classification of all `async_hooks` exports as deprecated was
removed: [AsyncLocalStorage is stable](https://nodejs.org/api/async_context.html#class-asynclocalstorage).

`bun run depcruise --info` reports analyzer capabilities. `bun run deps:graph`
regenerates `assets/dependency-graph.svg` and requires Graphviz's `dot` executable.
Ensure `dot -V` identifies Graphviz, not an unrelated executable with the same
name. Both commands use the same ESM architecture configuration.

Run every applicable check above, including the live suite, before declaring code
ready. `bun test`, watch, coverage and debug defaults use only `tests/unit`; the
E2E preload is opt-in via `test:e2e`. Aggregate Nx gates and independent service
suites belong to later tickets in [the migration](adr/0002-adopt-nx-with-nest-and-bun.md).

The remaining objectives are Nx, application-owned ports/transactions and durable
service integration. See the
[dependency inventory](dependencies.md) for version decisions and security overrides,
and the [combined issue #8 execution record](validation/issue-8-upgrade.md) for
final validation. The [issue #7 record](validation/issue-7-checks.md) retains the
historical diagnostics and audit finding before remediation.

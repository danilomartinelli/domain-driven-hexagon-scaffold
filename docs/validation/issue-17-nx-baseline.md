# Issue #17: Nx/Bun runnable baseline

Validated on September 29, 2026 against `origin/master` at
`0b3d7b81fe1241e539b79cc74ad73d9726a7f66f`, using Bun 1.4.2 on macOS arm64
and the existing PostgreSQL 18.6 Docker image. This record covers the
[transitional Nx workspace](../nx-workspace.md), not independent User/Wallet
services or deployment.

## Installation and project discovery

- `bun install --frozen-lockfile` passed in the working checkout and a fresh
  temporary copy with no `node_modules`, `.nx`, `.git` or environment files.
  The fresh copy installed 544 packages, then all eight typecheck targets and
  all three unit-test targets passed. Husky correctly reported the absence of
  Git metadata in that temporary installation; the real checkout installs hooks.
- `bun audit` reported no vulnerabilities across 512 audited packages after
  the documented `smol-toml` override.
- `bun run nx show projects --json` discovered ten projects: `legacy-app`,
  `core`, `nest-support`, `example`, `config`, `database`, `infrastructure`,
  `test-runner`, `e2e`, and `workspace`.
- `bun run nx graph --file=.context/project-graph.json` confirmed actual source
  edges from the app to the technical libraries, from E2E to the app/libraries,
  and from database scripts to app connection configuration. Explicit command
  dependencies connect E2E, the runner, database and infrastructure. The source
  dependency SVG was regenerated with Graphviz 16.1.0.

## Quality and live behavior

`NX_SKIP_NX_CACHE=true bun run check:full` passed with fresh execution of every
applicable gate: formatting, eight strict lint scopes, eight typecheck scopes,
architecture, unit suites, runner lifecycle checks and provisioned E2E.

| Suite                                        | Result                                                                                |
| -------------------------------------------- | ------------------------------------------------------------------------------------- |
| Application domain/commands/serialization    | 16 passed                                                                             |
| Generic core errors and command input guards | 2 passed; assertions relocated from the existing app exception suite                  |
| Existing deep-module example                 | 2 passed                                                                              |
| Real Docker runner lifecycle                 | 3 passed, including concurrent isolation, failure exit status and interrupted cleanup |
| Gherkin and database regressions             | 11 passed: seven original Gherkin cases and four integration cases                    |

The full gate's E2E run used its own Compose project and database;
`commandExitCode`, `cleanupExitCode` and `exitCode` were all zero. A separate
`bun run test:e2e --test-name-pattern 'Wallet persistence failure'` ran exactly
one passing case, confirming argument forwarding through both Nx targets and
isolated provisioning. Every live invocation provisioned and cleaned new
resources; none reused a cached result.

A provisioned disposable database also exercised `start`, `start:dev`,
`start:debug` and `start:prod` through their package scripts/Nx targets. Each
served `GET /v1/users` with HTTP 200, the debug command opened the Bun inspector,
and SIGTERM left no listener on port 3000. Existing environment files and
persisted development volumes were not changed.

## Negative checks and cache invalidation

Temporary probes were restored after each run:

- Repeating `legacy-app:typecheck` reused the successful cache entry.
- Introducing an invalid exported type in `core/errors.ts` made the app's
  typecheck execute and fail, proving source dependency invalidation.
- An invalid target in shared TypeScript configuration also invalidated the
  cached app result and failed.
- Changing the expected static type in `src/type-tests/final.decorator.ts`
  failed typecheck, proving the compile-time fixture is still included.
- Importing a core implementation file from the app failed the private
  entry-point rule; importing Nest inside core failed context independence.
- Restoring the original files restored passing type and boundary checks.

Local logs and per-run cleanup evidence are retained under `.context/`; they
are intentionally not repository artifacts. Projects without their own test
suite are listed in the workspace guide and expose no empty-success test
placeholder. Remote CI, merge, independent distributions and deployment are
not claims of this validation.

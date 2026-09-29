# Deep-module setup validation

Validated on September 29, 2026 with Bun 1.4.2 and the existing
dependency-cruiser 18.4.0. The user selected `src/packages` for new packages,
preserving `src/modules` until the planned Nx migration.

## Configuration and discovery

The package entry-point, test privacy and global no-cycle rules were merged
into `.dependency-cruiser.mjs`, preserving the core and layer restrictions,
TypeScript resolution and Bun export conditions. No dependency upgrade,
TypeScript configuration change or new alias was needed.

`lint:boundaries` scans `src`, `tests` and `scripts`; `deps:validate` delegates to
it. The existing `check:code` and pre-commit hook include it. The example package
and its two public-interface tests run through `test:unit`, the default test
script, watch, coverage and debug scripts without the E2E preload.

## Executed probes

Every temporary probe was removed after execution. Logs and the result matrix
are in `.context/deep-modules/` for this workspace.

| Probe                                                              | Observed result                               |
| ------------------------------------------------------------------ | --------------------------------------------- |
| Clean example                                                      | Pass, exit 0                                  |
| Example test imports `../lib/impl`                                 | `tests-through-entrypoints`, exit 1           |
| Remove that import                                                 | Pass, exit 0                                  |
| App imports a package implementation                               | `entrypoint-boundary-from-app`, exit 1        |
| Package imports another package's implementation                   | `entrypoint-boundary-across-packages`, exit 1 |
| Production imports its own test fixture                            | `tests-folder-is-private`, exit 1             |
| Test imports another package's fixture                             | `tests-through-entrypoints`, exit 1           |
| Multiple root entry points, internal imports and own test fixtures | Pass, exit 0                                  |
| Cycle between two internal files                                   | `no-circular`, exit 1                         |
| Type-only deep import from an arbitrary subfolder                  | `entrypoint-boundary-from-app`, exit 1        |
| Restore all probes                                                 | Pass, exit 0                                  |

## Existing graph and behavior

Enabling the cycle rule required removing five existing cycles. Exception
constants now import directly. User/Wallet schemas moved out of repositories so
both repositories and mappers can consume them without reciprocal imports.

The property converter now performs its existing structured clone directly:
class prototypes were already removed before the old Entity/ValueObject checks,
so those checks could not unpack the cloned instances. Two characterization
tests passed before and after simplification, checking nested data, dates,
mutation isolation, stored-property shapes and public serialization freezing.

Expanding the scan to external tests found one unused date fixture; it was
removed after confirming it had no consumers. The dependency graph was
regenerated.

`bun run check:full` passed formatting, lint, types, dependency validation
(145 modules and 401 dependencies), 18 core/package tests, three real-Docker
runner lifecycle tests and 11 application tests. All seven original Gherkin
cases and the compile-time decorator fixture remain included. Database runs
performed their normal isolated resource cleanup.

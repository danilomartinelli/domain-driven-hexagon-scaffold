# Issue #7: strict developer checks

Validated on September 29, 2026 with **Bun 1.4.2**, against the issue #5 and #6
implementation already merged in `origin/master` (`710fd81`).

## Checks and compatibility

The [developer guide](../developer-checks.md) records the registry lookup and
support matrix: TypeScript **6.0.3**, ESLint **10.11.0**, typescript-eslint
**8.71.0**, Prettier **3.9.9**, dependency-cruiser **18.4.0**. TypeScript 7.0.2
was the registry latest, but is outside the supported parser/analyzer ranges.

After enabling strict settings, typed lint and tooling coverage, the first run
reported **28 TypeScript diagnostics** and **128 lint errors / 1 warning**.
Corrections include populated DTO field declarations, mapper and query result
contracts, unknown exception handling, awaited listener return types, typed
migration-history rows and removal of obsolete APIs/file-wide suppressions.

| Executed command                                      | Result                                                                            |
| ----------------------------------------------------- | --------------------------------------------------------------------------------- |
| `bun install --frozen-lockfile`                       | Passed, no dependency or lockfile changes; 484 packages                           |
| `bun run typecheck`                                   | Passed, zero project diagnostics, no emission                                     |
| `bun run lint`                                        | Passed, zero errors and warnings                                                  |
| `bun run format:check`                                | Passed, no formatting differences                                                 |
| `bun run deps:validate`                               | Passed, 109 modules / 299 dependencies, zero violations                           |
| `bun run deps:graph`                                  | Passed with Graphviz 16.1.0; generated SVG, original illustrative asset preserved |
| `bun run depcruise --info`                            | Passed, TypeScript 6.0.3 support enabled                                          |
| `bun test tests/user/create-user/create-user.test.ts` | 6 passed, 0 failed                                                                |
| `bun test tests/user/delete-user/delete-user.test.ts` | 1 passed, 0 failed                                                                |
| `bun test`                                            | 7 passed, 0 failed, 13 assertions across the original 2 files                     |
| `git diff --check`                                    | Passed                                                                            |

The feature files and case assertions are unchanged. No test scenarios, suites,
mocks, hooks, CI or aggregate checking routine were added. The test context and
HTTP client now express the existing staged setup and external response types.
The seven cases do **not** prove atomic rollback; transaction publication and the
wallet listener still await the existing request-scoped transaction flow.

`skipLibCheck` remains enabled for third-party declarations, with all project
sources checked. A separate diagnostic run without it found missing optional
Nest gateway/AST declarations and ambient Bun/jest-cucumber declaration conflicts;
these are not application diagnostics or a reason to install unused runtimes.
The strict preset has no global rule relaxations; four documented local
directives preserve framework/marker classes and an event-specific constructor.

## Real PostgreSQL and database tools

Validation used an owned, temporary `postgres:18.6-alpine` container named
`ddh-issue7-postgres`, bound to `127.0.0.1:55437`, database `ddh_issue7_tests`.
Commands received these shell overrides with the local example user/password.
No shared development database or `.env` file was modified.

- `migration:up:tests`: applied the baseline to the empty database.
- `migration:status:tests`: reported the baseline as applied.
- `seed:up:tests`: loaded both SQL fixtures and committed.
- `migration:down:tests`: rolled the baseline back.
- `migration:status:tests`: reported the baseline as pending.
- `migration:up:tests`: reapplied the baseline.
- Final native `bun test`: passed all seven cases against that schema.

The graph command initially selected an unrelated `dot` dotfiles helper.
Graphviz 16.1.0 was installed locally and the command passed with
`PATH="/opt/homebrew/bin:$PATH" bun run deps:graph`. The generated SVG is a local
validation artifact; the existing illustrative asset was restored.

## Remaining work

`bun audit` reported **one moderate advisory**:
[GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq), affecting
`uuid` 9.0.1 (direct) and 10.0.0 (through jest-cucumber). No audit exception was
accepted or concealed. Whole-tree dependency remediation and combined acceptance
remain in #8; this slice does not claim the parent's security acceptance.

Nx conversion, correction of hexagonal coupling, and completion of CLI/messaging
startup remain explicitly deferred by [ADR 0001](../adr/0001-modernize-with-bun.md).
The current layer exceptions and unused examples remain in place.

## Review

The `code-review` skill reviewed the change against `origin/master` in separate
Standards and Spec agents. Standards found no hard violations and one optional,
pre-existing duplication in REST/GraphQL response mapping; extracting it is
outside this tooling slice. Spec found no missing requirements, scope creep or
incorrect implementations. The reviewer independently reran type, lint and
architecture checks successfully. The two documentation corrections (28 initial
type diagnostics and the retained transitive resolver dependency) are included.

### `@final` static-member regression

The local PR review identified a confirmed regression: decorating a class with
`static create` produced TS1270 because the decorator returned only a constructor
signature, discarding the class's static members. `final` now accepts and returns
the complete constructor type `T`; the wrapper still inherits the original class
and rejects subclass instantiation.

The compile-only fixture `tests/types/final.decorator.ts` exercises decorator
syntax, a static factory and field, a required constructor argument, and instance
properties. With the fixture added before the fix, `bun run typecheck` failed
with TS1270 naming the missing `kind` and `create` members; it passes after the
fix. The fixture uses the existing typecheck command and adds no runtime suite
or Gherkin scenario.

Type, lint, formatting and architecture checks passed. The original minimal
compiler reproduction passed after the fix, as did focused runtime assertions
for static factory calls, static fields, constructor arguments and subclass
rejection. All seven existing Gherkin cases passed with 13 assertions against
an isolated PostgreSQL 18.6 container and a freshly migrated `ddh_final_tests`
database. The owned container was removed afterward.

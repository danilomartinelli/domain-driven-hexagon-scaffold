# Issue #6 execution record

Validated on 2026-09-29 in the Karachi checkout, based on `origin/master`
`de309c4`. Runtime/package manager: **Bun 1.4.2**. Database: **PostgreSQL 18.6**,
owned disposable Compose project `ddh-issue6`, service `postgres-test`,
`localhost:5434/ddh_tests`. No development or production database was used.

## Baseline and compatibility changes

The six existing creation cases passed on the Nest 9 baseline. After updating
the packages, `bun run typecheck` reported TS2422 for the unparameterized
`ICommandHandler` and `IQueryHandler` declarations. Supplying the existing
command/query types fixed those new conditional-interface errors. The CLI and
request-context wrappers were removed, and wallet listener error suppression
was explicitly disabled to preserve the awaited transaction path.

Stable registry metadata and all installed required peer ranges were checked;
the selected matrix and official references are in [adapter compatibility](../adapters.md).
GraphQL 16.14.2 is intentional: Apollo Server 5.5.1 requires `^16.11.0`, although
GraphQL's newest stable major is 17. Optional, unused federation, WebSocket,
Fastify and microservice transport peers were not installed.

## Application and schemas

- Before and after the upgrade, initialized the full `AppModule`, executed
  `SELECT 1` through the real injected Slonik pool, captured the generated
  GraphQL SDL and OpenAPI document, and awaited `app.close()`.
- The GraphQL SDL is byte-for-byte unchanged. The OpenAPI diff preserves paths,
  operation IDs and DTO schemas; Swagger adds automatic controller tags and
  relocates query examples into parameter schemas (plus JSON key ordering).
- `NODE_ENV=test bun run start` initialized every registered module and listened
  on port 3000. `/v1/users`, `/docs`, `/docs-json` and the GraphiQL page at
  `/graphql` returned HTTP 200.
- A manual `create(input: ...)` GraphQL request returned the user ID;
  `findUsers(options: "{}")` returned the created user's existing fields and
  pagination shape. REST deletion returned HTTP 200. These are compatibility
  checks against the running application, not new automated adapter suites.
- Sent SIGTERM to the owned application process. Nest completed shutdown;
  `pg_stat_activity` then contained zero other connections to `ddh_tests`.
  The runner reported termination by SIGTERM as expected. The separately
  awaited `app.close()` check exited successfully.

CLI and messaging were reviewed through their registration, types and source
contracts. Commander retains `new user <email> <country> <postalCode> <street>`
and awaits the existing command handler. The message pattern remains
`user.create`, returning `IdResponse` from the same command. Neither has a
complete bootstrap/context/transport lifecycle; no end-to-end execution is
claimed for them.

## Existing behavioral and static checks

Prepared the database with the existing Compose file (using project name
`ddh-issue6`) and `bun run migration:up:tests`. Ran the creation and deletion
files individually during implementation. The final full native `bun test`
run, after a clean frozen installation, reported:

```text
7 pass
0 fail
13 expect() calls
Ran 7 tests across 2 files. [530.00ms]
```

The seven Gherkin cases and their bindings/assertions are unchanged. Nest,
HTTP, validation, CQRS, events and PostgreSQL remain real. **This suite does not
prove atomic rollback**; the awaited user/wallet transaction and error
propagation were reviewed in [the adapter guide](../adapters.md#request-isolation-and-transaction-participation).

- Clean `bun install --frozen-lockfile`: installed 525 packages successfully.
  A second frozen installation checked 563 installs across 526 packages with no
  changes. No legacy Apollo server, Playground, subscription transport,
  `nestjs-console` or `nestjs-request-context` package remains in the resolved tree.
- `bun run typecheck`: passed with the repository's current TypeScript settings.
- `bun --bun eslint 'src/**/*.ts' 'tests/**/*.ts'`: passed, no diagnostics.
- Prettier checks on application/test source, package metadata and changed
  Markdown passed. `git diff --check` passed.
- `bun run deps:validate`: exit 0, but **0 modules / 0 dependencies cruised**,
  both before and after this change, plus the existing Node `fs.R_OK` warning.
  This is not meaningful architectural validation. Updating the analyzer and
  its TypeScript support belongs to #7, which remains open.
- `bun audit`: **16 alerts** (1 critical, 5 high, 8 moderate, 2 low), grouped
  under ajv, handlebars, lodash, qs and uuid in the remaining tree. Full
  dependency remediation and combined validation belong to #8; this is not a
  clean audit, completion of parent #3, or an accepted security exception.

No new validation script, suite, CI, hook, deployment or production migration
was introduced. Future objectives remain **Nx monorepo; correction of hexagonal
coupling; completion of the CLI and messaging examples**.

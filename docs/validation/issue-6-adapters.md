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

## PR #11 review follow-up: GraphQL HTTP compatibility

On 2026-09-29, reproduced the attached review findings on `ed73c8e` using the
full `AppModule`, its global validation pipe, real HTTP requests and an owned
disposable PostgreSQL 18.6 instance. The Compose project was
`ddh-issue6-review`, service `postgres-test`, at `localhost:5434/ddh_tests`;
the existing `bun run migration:up:tests` prepared its schema.

The temporary reproduction scripts and before/after logs live in the ignored
`.context/review/` directory. They are review probes, not additions to the
seven-case automated suite, as required by issue #6.

```sh
NODE_ENV=test bun .context/review/cors-minimal.ts
NODE_ENV=test bun .context/review/graphql-contract-probe.ts
```

Before the fix, the minimized preflight failed with `400 !== 204` and no
`Access-Control-Allow-Origin`. The full probe also found missing CORS headers
on successful JSON POSTs and validation-error responses: four failed checks.
Repeating the preflight alone reproduced the same failure without a mutation
or validation pipe.

The cause was the removal of automatic CORS setup in Apollo's Express
integration. `AppModule` now registers `cors()` for `graphql` before Apollo;
`cors` 2.8.6 is a direct dependency, with `@types/cors` 2.8.19 for static checks.
Both original probes then passed. The full probe checked:

- Preflight HTTP 204, wildcard origin, allowed POST and requested headers;
  wildcard origin also present on GraphQL success and validation errors.
- REST listing still returns HTTP 200 without CORS; REST and the unrelated
  `/graphql-other` route do not acquire CORS on preflight.
- Real GraphQL user creation and deletion, validation details under
  `BAD_REQUEST` / `originalError`, and duplicate-email errors without the
  legacy `exception` extension.
- CSRF rejection of GET without a qualifying header, successful GET with
  either supported preflight header, rejection of plain-text/form POSTs without
  that header, and rejection of batched operation arrays.

The error payload and request-format changes are retained and explicitly
documented in [GraphQL client migration](../adapters.md#graphql-client-migration),
including the client adjustments. No legacy formatter or weaker CSRF setting
was added.

After the fix, `bun test` again reported **7 pass, 0 fail, 13 assertions** with
real PostgreSQL. Typecheck, ESLint, Prettier, frozen installation and
`git diff --check` passed. The probes await `app.close()`; the owned disposable
database was removed after validation. These are local results; no remote CI,
deployment or production migration was performed.

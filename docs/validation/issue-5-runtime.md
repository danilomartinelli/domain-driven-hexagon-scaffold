# Issue #5 execution record

Validated on 2026-09-29 in the Boston checkout, based on master `7948db4`.
Runtime and package manager: Bun **1.4.2**. PostgreSQL: the issue #4 disposable
`ddh-postgres-test-1` service, **18.6**, `localhost:5434/ddh_tests`.
No production database or development container was used.

## Before and after

The original creation test failed before running any scenarios under native Bun:

```text
SyntaxError: Export named 'DatabasePool' not found in module '.../slonik/dist/src/index.js'.
0 pass, 1 fail, 1 error
```

After updating dependencies, type-only imports, the provider, SQL contracts and
test setup, the creation file passed its six cases and the deletion file passed
its one case. The final full `bun test` run used the real application:

```text
Create a user > I can create a user                              pass
Create a user > I try to create a user with invalid data (5 rows) pass
Delete a user > I can delete a user                              pass

7 pass
0 fail
13 expect() calls
Ran 7 tests across 2 files. [617.00ms]
```

The `.feature` files are unchanged. Renaming the two bindings to `*.test.ts`
enables native discovery. No scenario, assertion boundary, database mock or
additional suite was introduced. These are the application's seven cases, not
the isolated Bun/Gherkin probes from the earlier investigation. They **do not
prove atomic rollback**; the transaction and error propagation review is in
[the runtime guide](../runtime.md#persistence-and-transaction-review).

## Operational and static checks

- `bun install --frozen-lockfile`: passed; 649 installs checked across 587 packages,
  no changes to the lockfile.
- `bun run docker:tests` and `bun run migration:up:tests`: passed; the issue #4
  baseline was applied to the disposable validation database.
- `bun run typecheck`: passed with TypeScript 6.0.3 and `noEmit`. This preserves
  the current strictness settings; repository-wide strict diagnostics belong to #7.
- `bun --bun eslint 'src/**/*.ts' 'tests/**/*.ts'`: passed under the retained
  configuration. This is not completion of the newer lint configuration in #7.
- Prettier checks on application/test source, configuration and updated runtime
  documentation passed, as did `git diff --check`.
- `NODE_ENV=test bun run start`: application started from source with all modules.
  REST `/v1/users`, OpenAPI `/docs-json` and a GraphQL schema introspection request
  returned HTTP 200. The schema exposes query and mutation roots.
- `NODE_ENV=test bun run start:dev`: started and restarted on a source change.
- `bun run start:prod` with explicit **validation** DB settings: started from source.
  The retained Apollo 3 emitted its existing unbounded persisted-query-cache warning;
  the framework/security upgrades remain in later tickets.
- `DB_NAME=ddh bun test tests/user/create-user/create-user.test.ts`: rejected by
  preload before importing the application or opening a database pool.
- Shutdown and test cleanup: after stopping the application, no other connections
  remained in `pg_stat_activity` for `ddh_tests`. After the suite, users and wallets
  were empty and migration history remained applied.

Independent code-review axes against `origin/master` both reported no findings:
**Standards: 0; Spec: 0**. The review included pool lifecycle, row validation,
runner/setup behavior, adapter preservation and the transaction/error chain.

## Limits and follow-up

`bun run deps:validate` exited successfully but reported **0 modules and
0 dependencies cruised**. It is not a valid architectural check: retained
dependency-cruiser 12.12.2 only enables TypeScript versions `<6`, as confirmed by
`depcruise --info`. Its upgrade and the remaining architecture/tooling validation
belong to #7. The existing architectural rules and concessions were not relaxed.

The Nest/Apollo/CLI framework stack, remaining lint dependencies and full-tree
security remediation are deliberately left to their following tickets. This
record does not claim the parent modernization issue is complete, a clean
security audit, CI approval, a merge or deployment. No CI, aggregate validation
command, new migration, CLI bootstrap or messaging transport was added.

The next architectural objectives remain **Nx monorepo**, **removing hexagonal
coupling**, and **completing the CLI and messaging examples**.

---
name: nx-run-tasks
description: Select and execute existing Bun/Nx tasks with this repository's test, cache and isolated-environment contracts.
---

Finish [developer setup](../../../docs/developer-checks.md#setup), then inspect the
requested project's resolved targets with `bun run nx show project <name> --json`.
Use package scripts for quality gates and `bun run nx run <project>:<target>` for
focused feedback. Use `bun run nx`; direct `npx nx` bypasses repository settings.

- Unit feedback: `bun run test:unit`, or an existing project's `test` target.
  Bare `bun test` only discovers `src/packages/core/tests`.
- Code feedback: focused lint/typecheck targets and `bun run lint:boundaries`.
- Final code validation: `bun run check:light`, which the pre-commit hook runs.
  `bun run check:full` (Docker) runs the complete local suites on demand.
- Documentation-only work: format changed files, run `bun run check:docs` and
  verify changed commands.
- Live behavior: `bun run test:e2e` owns provision/migrate/seed/test/cleanup;
  prepared targets require the selected environment through `env:exec`.
- Infrastructure/runner changes: before staged review, select and execute the
  affected applications' `test-component` targets as described in
  [focused feedback](../../../docs/developer-checks.md#focused-feedback), then
  run the applicable lifecycle target. Include transitive dependents even when
  no application file changed.
- Application or E2E changes: follow the preservation selection in
  [focused feedback](../../../docs/developer-checks.md#focused-feedback).

Affected runs are focused feedback, not a replacement for the light gate. Use
`origin/master` as the comparison base and include unstaged/new files when that
is the task's scope. Use `--skip-nx-cache` when fresh execution evidence is needed.
Live targets are intentionally uncached. Use `&&` for sequential checks, or
separate tool calls and inspect every exit status, as shown in
[focused feedback](../../../docs/developer-checks.md#focused-feedback).
A later successful check must not hide an earlier failure. Report cleanup
failures separately. Nx Cloud is disabled; do not enable it or
start CI repair/publishing merely because an upstream skill mentions it.

# Retrospective follow-up: local validation and agent workflow

Implemented after the issue #16 delivery, following the requested retrospective
actions. This automates the current PostgreSQL application; it does not complete
the Nx, RabbitMQ or independent-service scopes of issues #18 and #35.

## Changes

- Husky installs through `prepare`; pre-commit runs lint-staged/Prettier and
  the shared infrastructure-free `check:code` command.
- `check:full` adds the runner lifecycle suite and automatically provisioned
  application E2E. The existing prepared-database command remains explicit.
- Each database run has its own project, database, loopback port and tmpfs.
  Logs and result metadata survive cleanup under `.context/test-runs/`.
- `implement`, `code-review` and `AGENTS.md` agree on reviewing an immutable
  staged tree before commit, including new files, with identical comparisons
  for Standards and Spec reviewers.
- Tracker guidance lists bounded summaries first and fetches selected bodies
  and discussions. Source exploration starts with file/symbol searches.

## Verification

Bun 1.4.2 and PostgreSQL 18.6 were used locally.

- Frozen installation installs Husky; audit reports no vulnerabilities across
  441 checked packages.
- A staged TypeScript error (`string = 123`) made the installed pre-commit hook
  fail with TS2322 and exit 2. The probe was removed afterward.
- Runner tests use real Docker/PostgreSQL: one failing run returns 23 and cleans
  up while a concurrent successful run retains its database and completes with 0.
- A command ignoring SIGTERM is forcibly terminated; the runner records the
  child status 137, returns interruption status 143, and removes its container
  and network.
- A first SIGTERM during cleanup is retained as exit 143 while cleanup finishes.
  This regression initially failed with exit 0 and passes after the review fix.
- The full gate passes formatting, lint, types, architectural checks, 14 core
  tests, three runner lifecycle tests and all 11 live application tests. The seven
  original Gherkin cases and compile-time decorator fixture remain included.
- The documented issue-summary and PR-association queries were executed against
  the repository.

Historical validation records describe the commands that existed at their time.
Use [developer checks](../developer-checks.md) for the current workflow.

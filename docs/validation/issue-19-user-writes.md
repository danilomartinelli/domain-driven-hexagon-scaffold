# Issue 19: plain User write use cases

Scope: [issue #19](https://github.com/danilomartinelli/vibecoding-starter-js/issues/19),
the User write slice of [ADR 0002](../adr/0002-adopt-nx-with-nest-and-bun.md).
The seven original Gherkin scenarios remain unchanged.

## Delivered behavior

- Plain TypeScript CreateUser/DeleteUser own input/result models, persistence
  operations, explicit operation metadata and the atomic recording scope.
- Nest CQRS handlers map commands and supply generated identity/time. The
  existing REST/GraphQL response/error mappings remain; CLI/message adapters
  validate requests and delegate without HTTP context.
- Repositories only persist. The Slonik transaction adapter owns scoped
  connections and temporary synchronous Wallet coordination. No connection
  enters a use case or request context.
- Duplicate email, guest role/address semantics, missing-user deletion and
  Wallet survival after deletion are preserved.
- Core tests use a copy-on-write port implementation to observe profiles and
  recorded facts. Failure during recording leaves both unchanged.
- PostgreSQL regressions exercise scoped persistence without dispatch, explicit
  metadata without request context, creation/deletion dispatch failure rollback
  and the real CLI/message composition.

## Validation

The initial creation and deletion tests failed because their plain use cases did
not exist. After implementation, all seven native write-use-case tests pass.
The full gate and final staged review are recorded in the pull request.

### Review corrections: September 30, 2026

The former repository providers had no consumers, but Nest still instantiated
User and Wallet repositories against the database pool. A probe of the real
application container found both singletons before the correction and neither
afterward. Their providers, DI tokens and injection decorators are removed;
repository constructors now require a transaction connection supplied by the
Slonik adapter.

The prepared-environment preservation check accepted seven passing Gherkin
cases even if the database regressions were absent. It now requires the two
Gherkin files, both integration files and a zero-failure summary, stripping ANSI
formatting from the runner output without copying the growing test total.
A disposable workspace with integration tests omitted from the prepared target
still passed all seven Gherkin cases, but failed the corrected preservation
check. The unchanged target passed the real preservation check with all 17
application regressions, including development and sibling data verification.

The [write-path explanation](../runtime.md#persistence-and-transaction-review)
identifies transaction and publication authority and the remaining transition.
This slice has no durable outbox, post-commit broker publication or independent
Wallet consumer. In-process listener side effects cannot be undone by database
rollback. Deployment and the asynchronous cutover are outside this issue.

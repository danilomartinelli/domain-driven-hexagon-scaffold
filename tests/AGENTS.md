# Application integration test instructions

This directory contains Gherkin scenarios in `user/` and database/API regressions
in `integration/`. Infrastructure-free application tests belong in `src/tests/`;
package tests belong beside their package under `src/packages/`.

## Setup and isolation

- Keep [the preload](setup/preload.ts) validating the selected owned test
  environment before importing the application or opening pools. Use its
  `bun:test` configuration for `jest-cucumber`.
- Use [test-server helpers](setup/test-server.ts) for the application, HTTP server
  and database pool. The application owns and closes the pool.
- Preserve `assertTestEnvironment()` before database truncation. Setup clears
  User/Wallet data before the first test and after each test, while retaining
  migration history. Tests must create their own data rather than depend on
  another scenario or the initial seeds.
- Keep Gherkin scenarios and their step definitions aligned. Exercise database
  and API regressions through the real application and disposable database.

## Running tests

Run from the repository root with Docker available:

```sh
bun run test:e2e
bun run test:e2e --test-name-pattern 'Wallet persistence failure'
```

For a single file, retain both the environment wrapper and preload:

```sh
bun scripts/with-test-database.ts -- bun test --preload ./tests/setup/preload.ts ./tests/user/create-user/create-user.test.ts
```

The wrapper provisions, migrates, seeds and shuts down its owned environment.
For repeated runs, follow [prepared test environments](../docs/database.md#disposable-tests);
`test:e2e:prepared` needs an already migrated and seeded environment selected
through `env:exec`. Bare `bun test` and `bun run test:unit` do not run this suite.

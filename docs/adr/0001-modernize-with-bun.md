---
status: accepted
date: 2026-09-29
---

# Modernize with Bun while preserving the educational scope

This educational repository will be upgraded to maintained dependencies, addressing known vulnerabilities without preserving backward compatibility. We will adopt **Bun 1.4.2 as both the runtime and package manager**, keeping Nest, PostgreSQL, and Slonik up to date. The upgrade will preserve the repository's hexagonal architecture purpose and the examples' functional scope; conversion to Nx and cleanup of architectural coupling will be separate, future work.

## Decisions

- Run TypeScript directly with Bun and remove the additional transpilation toolchain that is no longer needed, including `ts-node`, `ts-loader`, `tsconfig-paths`, and `ts-jest`. Keep TypeScript for static type checking with `noEmit`, since the runtime does not check types. Adjust modules, imports, and scripts for Bun and ESM dependencies.
- Version `bun.lock` and pin Bun to 1.4.2. For other components, choose LTS versions where that policy exists, and stable, maintained, mutually compatible versions otherwise. Do not adopt beta versions or incompatible configurations just to use the highest version number. The explicit choice of Bun as the runtime replaces the proposal to run the application on Node LTS with Bun only as the package manager.
- Preserve REST, GraphQL, CLI, and messaging. Update libraries and address breaking changes and warnings without completing examples that currently lack functional startup.
- Keep PostgreSQL and Slonik, replacing the incompatible Nest wrapper with a local provider that manages the pool lifecycle. Preserve user and wallet creation within the same transaction, and adapt the SQL, type, and validation contracts required by the upgrade.
- Replace the legacy migration workflow with versioned SQL migrations using stable `node-pg-migrate` 9, executed by Bun. The baseline may be rebuilt, and the seed workflow must follow the change; there is no requirement to retain the old history. The migrator includes `jiti` transitively, but the application, tests, and SQL migrations will not use it as a transpiler.
- Preserve Gherkin and the relevant existing scenarios, using an updated `jest-cucumber` with the native `bun test` runner. Remove the Jest runner and its TypeScript transformation; required type declarations may remain. The seven current cases remain the reference: valid creation, five invalid inputs, and deletion. Do not add scenarios; a scenario may be removed only if it no longer makes sense after the upgrade, not because of compatibility difficulties.
- Adopt strict TypeScript, ESLint flat config with strict rules and type information, and Prettier separate from linting. Fix every error, warning, and formatting discrepancy identified by the adopted configurations, without global disabling to hide problems.
- Fix known vulnerabilities in the resolved dependency tree, including development dependencies. Update affected scripts and instructions. Do not create CI or an additional validation routine; run the necessary checks and existing tests during implementation to verify the upgrade and report their results.

## Consequences and future goals

Direct execution with Bun removes the need to produce intermediate JavaScript to start the application. TypeScript remains necessary as a type checker: during the investigation supporting this decision, version 6 was compatible with the current typescript-eslint, while version 7 was still outside the supported range. Component versions, except the explicitly selected Bun 1.4.2, must be checked again during implementation.

The future spec and PR must record these next goals:

- Convert the repository to an Nx monorepo.
- Remove the domain's dependencies on request context, the framework, and concrete event publication, including the current exceptions in the architectural rules.
- Complete startup and executable examples for CLI and messaging.

This is an approved decision, not a statement that implementation is complete. Isolated probes confirmed Nest 12 execution with metadata and aliases under Bun 1.4.2, Gherkin integration with `bun test`, and SQL migration generation by the new migrator. Tests against the upgraded application and migration execution against PostgreSQL still need to be performed during implementation.

## References

- [Approved spec: modernize dependencies and fix vulnerabilities with Bun 1.4.2 — issue #3](https://github.com/danilomartinelli/vibecoding-starter-js/issues/3)
- [Bun: TypeScript without static type checking at runtime](https://bun.com/docs/runtime/file-types)
- [Bun: decorator metadata support](https://bun.com/blog/bun-v1.0.3)
- [jest-cucumber: configuring another test runner](https://github.com/bencompton/jest-cucumber/blob/main/docs/AdditionalConfiguration.md#configure-test-runner)
- [typescript-eslint: supported versions](https://typescript-eslint.io/users/dependency-versions/)
- [node-pg-migrate](https://github.com/salsita/node-pg-migrate)

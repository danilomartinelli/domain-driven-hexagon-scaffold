# Adding an application

Until the `nest-app` generator ([#34](https://github.com/danilomartinelli/vibecoding-starter-js/issues/34))
exists, a new application under `src/apps/<name>` needs every edit below.
`src/apps/wallet` is the worked example. The work is done when each item is
done or marked not applicable, with the reason, in the pull request.

These mechanics need no edit: `legacy-app` excludes `src/apps`, the
architecture rules match every `src/apps/*`, and `run-many` reaches the new
targets from `test:unit`, `lint`, `typecheck`, `test:component` and `check:full`.

## Project

- [ ] `src/apps/<name>/project.json`: name, tags `scope:<name>` and `type:app`,
      the same targets as `wallet` (with `--app=<name>` in `test-component`) and
      `implicitDependencies: ["test-runner"]`. Add a `tsconfig.json` extending the root.
- [ ] The layout in [src/apps/AGENTS.md](../src/apps/AGENTS.md), with configuration
      read from the application's own environment variables.
- [ ] `package.json`: `start:<name>`, `start:<name>:dev` and `start:<name>:debug`.

## Database

- [ ] An entry in [database/applications.ts](../database/applications.ts): name,
      `<NAME>_DB` prefix, migrations and seeds under `src/apps/<name>/database/`, and
      a runtime role.
- [ ] A baseline from `DATABASE_APP=<name> bun run migration:create <name>-baseline`
      that grants the runtime role exactly what the application needs.
- [ ] A listener port, `<NAME>_HTTP_PORT`, in the manifest schema and variables in
      `database/environment.ts` and in `newManifest` in `scripts/lib/environments.ts`,
      unless the manifest already reserves it.
- [ ] Registering an application changes existing manifests: development runs gain
      its database on the next `env:prepare`, and test runs need a new run ID.

## Guardrail tests

- [ ] [workspace.test.ts](../scripts/tests/workspace.test.ts): the new project's
      edges to shared packages, and no edge to or from another application.
- [ ] [boundaries.test.ts](../scripts/tests/boundaries.test.ts): representative
      violations for its core, its input adapters and cross-application imports.
- [ ] [environment-guard.test.ts](../scripts/tests/environment-guard.test.ts): its
      component preload refuses an unowned target.
- [ ] [environment.test.ts](../scripts/tests/environment.test.ts): a seed probe
      when its seed refers to another application's fixtures.

## Documentation

- [ ] [nx-workspace.md](nx-workspace.md): project row, graph edges and command rows.
      The workspace tests fail on a missing project row or script.
- [ ] [developer-checks.md](developer-checks.md): the architecture description, when
      the application adds rules or representative violations.
- [ ] `docs/<name>.md` with startup, migration, seed and API commands, linked from
      [database.md](database.md) and `src/apps/AGENTS.md`.
- [ ] The registered applications in [database.md](database.md) and
      [database/AGENTS.md](../database/AGENTS.md), and the project context in the root
      [AGENTS.md](../AGENTS.md).
- [ ] [ADR 0002's implementation status](adr/0002-adopt-nx-with-nest-and-bun.md#implementation-status)
      and [CHANGELOG.md](../CHANGELOG.md).

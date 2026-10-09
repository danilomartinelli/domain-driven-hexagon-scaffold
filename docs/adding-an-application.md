# Adding an application

Start with the [local `nest-app` generator](library-generators.md#application-capabilities):
`bun run nx generate @starter/generators:nest-app <name>` with the
`--persistence`, `--messaging` and `--exposure` choices. It supplies the private
project, `application.json` declaration, adapter/composition structure for the
enabled capabilities, independent configuration, test directories and
distribution targets without business behavior. Follow the checklist below as
behavior is added. Environment selection, ports and shared startup commands discover the declaration
automatically; business route registration remains explicit. `src/apps/wallet` is the worked
persistence example. Mark each item done or not applicable, with the reason, in
the pull request.

These mechanics need no edit: `type-fixtures` excludes `src/apps`, the
architecture rules match every `src/apps/*`, `run-many` reaches the new targets
from `test:unit`, `lint`, `typecheck`, `test:component` and `check:full`, and a
declared persistence capability joins the database tooling and distribution
migration commands without a registry entry.
The [workflow guardrails](../scripts/tests/workflow.test.ts) require the
declared applications to match the `type:app` projects, and every `type:app`
project to keep non-empty `test`, `test-component` and `test-distribution` suites. A generated app therefore fails `bun run check` until
its tests and the distribution verification below exist.

## Project

- [ ] `src/apps/<name>/application.json`: the name and the `persistence`,
      `messaging` and `exposure` capabilities the application really uses.
- [ ] `composition.json`: prepared integrations and functionality requirements,
      bound by the same names in runtime composition. Verify the
      [compatibility contract](application-compatibility.md) before provisioning.
- [ ] `src/apps/<name>/project.json`: name, tags `scope:<name>` and `type:app`,
      the same targets as `wallet` (with `--app=<name>` in `test-component`) and
      `implicitDependencies: ["test-runner"]`. Add a `tsconfig.json` extending the root.
- [ ] The layout in [src/apps/AGENTS.md](../src/apps/AGENTS.md), with configuration
      read from the application's own environment variables.
- [ ] With exposure enabled, declare only the business routes to register with
      Kong in `application.json`; see [route registration](database.md#explicit-public-routes).
      Unexposed applications contribute no routes. The environment supplies stable
      `<NAME>_HTTP_PORT` and applicable database and `<NAME>_RABBITMQ_URL` settings;
      do not add central application or port lists. Optional individual convenience
      scripts can delegate to `bun run nx run <name>:serve`, `watch` or `debug`.

## Database

Skip this section when persistence is not declared.

- [ ] `"persistence": true` in `application.json`. The derived
      [database applications](../database/applications.ts) then use the `<NAME>_DB`
      prefix, migrations and optional seeds under `src/apps/<name>/database/` and
      the `<name>_runtime` role.
- [ ] A baseline from `DATABASE_APP=<name> bun run migration:create <name>-baseline`
      that grants the runtime role exactly what the application needs.
- [ ] Declaring persistence changes existing manifests: development runs gain
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
- [ ] `distribution.json` listing the application's runtime imports (packaging adds
      the migration tooling's own dependencies for persistence), an uncached
      `distribution` target, delivered run/migration commands and a live
      `test-distribution` target that runs outside the workspace with only owned
      infrastructure. Publication preparation and the full image suite discover this
      target from the resolved Nx graph after artifact approval. When supplied
      `DDH_VALIDATED_IMAGE` and `DDH_IMAGE_PLATFORM`, it must execute that exact
      platform image rather than build or substitute another. This contract is
      documented, not enforced by the runner. Without an image, skip image-only
      lifecycle cases. Preparation logs absence of the optional target and continues
      with approval alone; this does not relax the workspace's non-empty-suite
      guardrail or add a mandatory publication scenario interface.
- [ ] `docs/<name>.md` with startup, migration, seed and API commands, linked from
      [database.md](database.md) and `src/apps/AGENTS.md`.
- [ ] The persistent applications in [database.md](database.md) and
      [database/AGENTS.md](../database/AGENTS.md), and the project context in the root
      [AGENTS.md](../AGENTS.md).
- [ ] [ADR 0002's implementation status](adr/0002-adopt-nx-with-nest-and-bun.md#implementation-status)
      and [CHANGELOG.md](../CHANGELOG.md).

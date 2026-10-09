# Agent Instructions

Before editing a subdirectory, read any `AGENTS.md` files along its path from
the repository root. Nested instructions add to this file; more specific
instructions take precedence within their directory and descendants.

## Project context

This is a Bun/Nx workspace with two independent NestJS applications. The User application in `src/apps/user/` owns profiles and durable
pending integration events in its own database. The independent Wallet application in
`src/apps/wallet/` owns Wallet creation from integration events, lookup and its own database; read
[src/apps/AGENTS.md](./src/apps/AGENTS.md) before working there.

- `src/packages/core/` contains framework-free technical primitives;
  `src/packages/nest-support/` contains Nest adapters, `src/packages/rabbitmq/`
  consumer/publisher lifecycles and failure-queue operations, `src/packages/integration-contracts/` versioned
  event envelopes and `src/packages/capabilities/` the parser for each app's
  `application.json` capability declaration. Keep business entities and use
  cases in the application.
- `database/` owns migration/seed tooling; application directories own their SQL;
  `scripts/` owns environment runners and repository checks; `tooling/config/`
  owns shared quality settings and `tooling/generators/` the local Nx generators.

Packages are deep modules: read [src/packages/AGENTS.md](./src/packages/AGENTS.md)
before adding or importing one. External callers and package tests use explicit
workspace package entry points (such as `@starter/core/domain`); tests may also
use their own fixtures. See [the Nx guide](docs/nx-workspace.md) for project
ownership and targets.

## Setup and local development

Run commands from the repository root. Use the Bun version in `.bun-version`,
install ripgrep (`rg`) and `make`, and run `bun install --frozen-lockfile`. Complete the
tool checks in [developer setup](docs/developer-checks.md#setup) before running
tests, formatting or Nx tasks. Use `bun run nx` for Nx commands; the wrapper
disables automatic dotenv loading and the daemon and gives interrupted runners
time to clean up.

For local development, run `make dev` (`bun run dev`): it prepares this
workspace's Docker services, applies migrations and watches both applications.
`make down` stops those services and keeps their volumes. Seeds stay explicit;
see [the database workflow](docs/database.md#development) for seeding, single
services through `env:exec` and prepared test environments. `make test` runs the
isolated system E2E suite.

## Agent skills

Claude Code, Codex and OpenCode share repository skills and reviewer instructions.
See [agent automation](docs/agents/automation.md) for configuration, activation
and the client-specific equivalents. Use Context7 for version-specific library
documentation; confirm versions against `package.json`. All Nx advice must retain
the `bun run nx` wrapper and the environment/cache rules in this repository.

### Issue tracker

Issues and specs are tracked in GitHub Issues for `danilomartinelli/vibecoding-starter-js` using the `gh` CLI. See `docs/agents/issue-tracker.md`.

An explicit [/implement](.agents/skills/implement/SKILL.md) invocation for an issue
authorizes commit, push and PR creation or update after the required reviews and
checks. A narrower session instruction takes precedence. Merge and deployment
remain separate actions.

### Triage labels

Use the default triage labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, and `wontfix`. See `docs/agents/triage-labels.md`.
Priority and impact labels are listed in [CONTRIBUTING.md](CONTRIBUTING.md#issues-and-labels).

### Domain docs

Use a single-context layout: root `GLOSSARY.md` and `docs/adr/`, created lazily as terms and decisions are resolved. See `docs/agents/domain.md`.

### Validation

Use `bun run test:unit` for infrastructure-free application and package tests;
bare `bun test` only discovers `src/packages/core/tests`.

The required gate for code, configuration or dependency changes is the light gate,
`bun run check:light`, which the pre-commit hook runs on every commit within a
three-minute budget: lint, types, architecture, unit tests, staged documentation,
staged dependency audit and workflow guardrails. Committing the reviewed snapshot
runs this final gate; no separate run is needed. GitHub CI runs `check:ci` (a
five-minute job) and the light native OCI image checks, `test:images:light` (a
fifteen-minute job per architecture).
The full local gate, `bun run check:full` (`make check`), runs on demand with
Docker: the `check:workspace` guardrail and mutation suites (documentation checker,
audit CLI, search and agent tooling tests among them), Docker lifecycle, Compose
operations, E2E, component, distribution and image suites. It is not required
before committing.
For documentation-only changes, format the affected files, run `bun run check:docs`
and verify changed commands. Targeted checks remain the development loop; see
[developer checks](docs/developer-checks.md) for focused suites and the scope of each gate.

### Review before commit

Review the intended staged changes, including new files, before committing.
Follow `.agents/skills/code-review/SKILL.md` to pin the base and index snapshot
for both reviewers; re-review fixes before committing the reviewed snapshot.
Write commit messages in the [CONTRIBUTING.md](CONTRIBUTING.md#commit-style) style.

### Focused exploration

Start with issue summaries or `rg` matches, then read the selected issue or code
range. See `docs/agents/issue-tracker.md` for bounded GitHub queries.

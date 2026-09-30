# Agent Instructions

Before editing a subdirectory, read any `AGENTS.md` files along its path from
the repository root. Nested instructions add to this file; more specific
instructions take precedence within their directory and descendants.

## Project context

This is a Bun/Nx workspace with NestJS applications. The transitional
`legacy-app` (`src/main.ts`) still runs User and Wallet business code from
`src/modules/` together. The independent Wallet application in
`src/apps/wallet/` owns Wallet lookup and its own database; read
[src/apps/AGENTS.md](./src/apps/AGENTS.md) before working there.

- `src/packages/core/` contains framework-free technical primitives;
  `src/packages/nest-support/` contains Nest adapters. Keep business entities
  and use cases in the application.
- `database/` owns the migration/seed tooling and the legacy content;
  `scripts/` owns environment runners and repository checks; `tooling/config/`
  owns shared quality settings.

Packages are deep modules: read [src/packages/AGENTS.md](./src/packages/AGENTS.md)
before adding or importing one. External callers and package tests use explicit
workspace package entry points (such as `@starter/core/domain`); tests may also
use their own fixtures. See [the Nx guide](docs/nx-workspace.md) for project
ownership and targets.

## Setup and local development

Run commands from the repository root. Use the Bun version in `.bun-version`,
install ripgrep (`rg`), and run `bun install --frozen-lockfile`. Complete the
tool checks in [developer setup](docs/developer-checks.md#setup) before running
tests, formatting or Nx tasks. Use `bun run nx` for Nx commands; the wrapper
disables automatic dotenv loading and the daemon.

For local development, follow [the database workflow](docs/database.md#development)
to prepare Docker services, migrate, seed and run the application through
`env:exec`. Preparation alone does not migrate or seed. The same guide covers
owned-resource shutdown and prepared test environments.

## Agent skills

Claude Code, Codex and OpenCode share repository skills and reviewer instructions.
See [agent automation](docs/agents/automation.md) for configuration, activation
and the client-specific equivalents. Use Context7 for version-specific library
documentation; confirm versions against `package.json`. All Nx advice must retain
the `bun run nx` wrapper and the environment/cache rules in this repository.

### Issue tracker

Issues and specs are tracked in GitHub Issues for `danilomartinelli/vibecoding-starter-js` using the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the default triage labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, and `wontfix`. See `docs/agents/triage-labels.md`.
Priority and impact labels are listed in [CONTRIBUTING.md](CONTRIBUTING.md#issues-and-labels).

### Domain docs

Use a single-context layout: root `GLOSSARY.md` and `docs/adr/`, created lazily as terms and decisions are resolved. See `docs/agents/domain.md`.

### Validation

Use `bun run test:unit` for infrastructure-free application and package tests;
bare `bun test` only discovers `src/tests`.

Before declaring code changes ready, run `bun run check:full` with Docker
running. For documentation-only changes, format the affected files, run
`bun run check:docs` and verify changed commands. See
[developer checks](docs/developer-checks.md) for focused suites and the scope
of each gate.

### Review before commit

Review the intended staged changes, including new files, before committing.
Follow `.agents/skills/code-review/SKILL.md` to pin the base and index snapshot
for both reviewers; re-review fixes before committing the reviewed snapshot.
Write commit messages in the [CONTRIBUTING.md](CONTRIBUTING.md#commit-style) style.

### Focused exploration

Start with issue summaries or `rg` matches, then read the selected issue or code
range. See `docs/agents/issue-tracker.md` for bounded GitHub queries.

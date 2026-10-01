# vibecoding-starter-js Vision

vibecoding-starter-js is an educational TypeScript starter that shows how to
build services with Domain-Driven Design and hexagonal architecture, maintained
by humans and AI coding agents working from the same rules.

It started as a fork of [Domain-Driven Hexagon](https://github.com/Sairyss/domain-driven-hexagon),
whose guide remains the [README](README.md), and is being modernized onto Bun
and Nx ([ADR 0001](docs/adr/0001-modernize-with-bun.md),
[ADR 0002](docs/adr/0002-adopt-nx-with-nest-and-bun.md)).

## Guiding principles

- The architecture is the lesson: domain and use cases stay plain TypeScript,
  independent of Nest, Slonik and RabbitMQ, and automated checks enforce those
  boundaries.
- Maintained, pinned toolchain: the Bun version in `.bun-version` is the
  runtime, package manager and test runner; other versions are stable and
  mutually compatible, with no known vulnerabilities in the locked tree.
- Strict by default: strict TypeScript, lint warnings fail and no global
  disables hide problems.
- Evidence over claims: infrastructure-free tests cover domain and use cases;
  real-infrastructure suites run in isolated, owned environments.
- One set of rules for every contributor: Claude Code, Codex and OpenCode share
  the repository's instructions, skills and reviewers.

## Current state

- User and Wallet run as independent Nest applications, each owning its
  PostgreSQL database. User publishes committed outbox events through RabbitMQ;
  Wallet consumes them idempotently. See [recovery evidence](docs/recovery.md).
- Nx orchestrates the applications, private technical packages (`core`,
  `nest-support`, `example`), database, tooling and regression projects; see
  [the Nx guide](docs/nx-workspace.md).
- The original Gherkin cases and database/API regressions run against
  provisioned PostgreSQL and RabbitMQ; see [developer checks](docs/developer-checks.md).

## Direction

Next:

- Repository-owned Nx generators (`nest-app`, `ts-lib`, `nest-lib`) that
  preserve the architectural boundaries.
- Complete startup and executable examples for the CLI and messaging adapters.

Contribution rules:

- Workflow, checks and commit style: see [CONTRIBUTING.md](CONTRIBUTING.md).
- Decisions that change direction are recorded as ADRs in `docs/adr/`.

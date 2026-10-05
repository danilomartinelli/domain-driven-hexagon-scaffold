# Domain-Driven Hexagon Scaffold Vision

Domain-Driven Hexagon Scaffold is an educational TypeScript starter that shows how to
build services with Domain-Driven Design and hexagonal architecture, maintained
by humans and AI coding agents working from the same rules.

It started as a fork of [Domain-Driven Hexagon](https://github.com/Sairyss/domain-driven-hexagon),
whose guide remains the [README](README.md), and now runs independent User and
Wallet services on Bun and Nx ([ADR 0001](docs/adr/0001-modernize-with-bun.md),
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

Runtime behavior and commands live in the [runtime guide](docs/runtime.md)
and [recovery guide](docs/recovery.md). Project ownership and orchestration
live in the [Nx guide](docs/nx-workspace.md); validation lives in
[developer checks](docs/developer-checks.md).

## Direction

The [adoption guide](docs/adoption.md) describes the delivered project identity,
MIT metadata and bounded rename command. Each application also declares
persistence, messaging and Kong exposure independently, and its generation,
runtime composition and probes follow those choices. The
[accepted scaffold delivery design](docs/scaffold-design.md) records the direction;
[ADR 0003](docs/adr/0003-application-capabilities-and-oci-delivery.md#implementation-status)
distinguishes these deliveries from the remaining environment, container topology
and OCI work.

Contribution rules:

- Workflow, checks and commit style: see [CONTRIBUTING.md](CONTRIBUTING.md).
- Decisions that change direction are recorded as ADRs in `docs/adr/`.

# Changelog

All notable changes to this project are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The project has no releases yet.

## [Unreleased]

### Changed

- Compose operations treat `deployment.json` as the desired selection for an
  installation's lifetime. `state.json` (version 2) records applied images with
  separate migration and startup outcomes and the retained owned resources; version 1
  inventories are adopted with their identities. Image updates record their
  candidate as desired, and inspection and shutdown use the applied inventory.

- Selected environments derive services, startup, ports, credentials, explicit Kong
  routes and applicable migrations from application declarations. Development
  reconciliation retains database and broker state across addition, disablement,
  removal and reactivation; `env:inspect` reports retained resources.

- Applications declare independent PostgreSQL persistence, RabbitMQ messaging and
  Kong exposure in `application.json`. The `nest-app` generator emits any of the
  eight combinations (defaults keep messaging and exposure), and readiness probes report disabled
  capabilities and unused messaging roles as `not_applicable`.
- Database tooling, distribution migration commands, failure-queue commands and
  required-suite guardrails discover applications from their declarations instead
  of a central list of application names. Persistent applications use the
  `<NAME>_DB` prefix, `<name>_runtime` role and `database/migrations/` conventions.
  Applications generated earlier need an `application.json` passed to
  `ServiceHealth`; discovery skips undeclared directories, while the workflow
  guardrail and packaging reject them.

### Fixed

- Unify Candidate Promotion so interrupted updates retain consistent evidence,
  older images require compatibility-reviewed rollback, and User/Wallet consumers
  keep timed-out transactions in flight through reconnect and shutdown.

- Keep timed-out generated message handlers tracked through drain, retain permanent payload rejections and preserve failure metadata.
- Expose parallel Nx runner validation as an uncached focused target and run it in CI.

### Added

- `ops apply --plan=<file>` applies a reviewed desired selection: it adds,
  removes, reconfigures and reactivates applications, provisioning identities
  before separate owner migrations and verifying each promoted candidate. Inactive
  services stop while databases, credentials, volumes and queued work are
  retained. A failed step stops later promotions; `ops continue` resumes the
  recorded progress without repeating migrations, and `ops retained` reports
  retained resources.
- `ops plan` previews a desired Compose selection against the applied installation:
  services to add, stop or recreate, retained resources, applicable migrations and
  expected interruptions, without changing it. Rejected images are explained first.
- `make dev`, `make test`, `make check` and `make down`, delegating to package
  scripts and uncached Nx targets. `bun run dev` prepares development
  infrastructure, migrates every application and watches both services.
- Workflow guardrails for Makefile delegation, full-gate composition, the Nx cache
  contract and non-empty required suites, plus a migration evidence map.
- Local Nx `nest-app` hybrid generator with independent HTTP/GraphQL and RabbitMQ
  lifecycle, explicit metadata, bounded shutdown and standalone distributions.
  Scratch-workspace and owned-broker probes validate generated projects.
- Local Nx `ts-lib` and `nest-lib` generators for private core and Nest libraries.
- Independent User and Wallet distributions that run and migrate outside the workspace.
- Separate liveness and readiness probes, outbox backlog diagnostics, correlated
  logs and bounded draining shutdown for both services.
- Failure-queue inspection and explicit replay commands for retained deliveries,
  with versioned contract compatibility fixtures.
- Kong DB-less gateway routing both REST APIs and separate GraphQL schemas.
- RabbitMQ delivery of User's committed outbox to Wallet with confirmations,
  idempotent commit-before-ACK consumption and a `user.create` command endpoint.
- Executable Nx project ownership and file-level architecture boundaries.
- Independent User application with an owned database and atomic profile/outbox
  persistence, preserved REST/GraphQL/Gherkin behavior and operation without Wallet
  or RabbitMQ. Pending events survive restart and profile deletion.
- Independent Wallet application with its own database, runtime role, migrations
  and seed, looking Wallets up by User identity through REST and GraphQL.
- Continuous integration running `bun run check`, focused runner subsets and the
  E2E, component and distribution suites on pull requests and `master`.
- Issue forms, pull request template, code owners and contribution, security,
  conduct, vision and third-party notice documents.
- Brazilian Portuguese translation of the README.

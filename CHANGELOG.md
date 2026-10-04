# Changelog

All notable changes to this project are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The project has no releases yet.

## [Unreleased]

### Fixed

- Keep timed-out generated message handlers tracked through drain, retain permanent payload rejections and preserve failure metadata.
- Expose parallel Nx runner validation as an uncached focused target and run it in CI.

### Added

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

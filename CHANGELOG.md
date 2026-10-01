# Changelog

All notable changes to this project are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The project has no releases yet.

## [Unreleased]

### Added

- Independent User application with an owned database and atomic profile/outbox
  persistence, preserved REST/GraphQL/Gherkin behavior and operation without Wallet
  or RabbitMQ. Pending events survive restart and profile deletion.
- Independent Wallet application with its own database, runtime role, migrations
  and seed, looking Wallets up by User identity through REST and GraphQL.
- Continuous integration running `bun run check` on pull requests and `master`.
- Issue forms, pull request template, code owners and contribution, security,
  conduct, vision and third-party notice documents.
- Brazilian Portuguese translation of the README.

# Contributing

Thanks for your interest in contributing! This guide covers the workflow and
the checks every change must pass.

## Getting started

1. Fork the repository (maintainers branch directly) and create a branch from `master`.
2. Complete the [developer setup](docs/developer-checks.md#setup): the Bun
   version in `.bun-version`, ripgrep (`rg`), `make` and `bun install --frozen-lockfile`.
3. With Docker running, `make dev` prepares local infrastructure, migrates and
   starts both services; `make down` stops it. See [the database workflow](docs/database.md#development).

Read [AGENTS.md](AGENTS.md) before editing: its project layout, package rules and
validation steps apply to human contributors as well as coding agents.

## Checks

| Change                              | Before opening a pull request                                                   |
| ----------------------------------- | ------------------------------------------------------------------------------- |
| Code, configuration or dependencies | `bun run check:full` or `make check` (Docker must be running)                   |
| Documentation only                  | Format the affected files, run `bun run check:docs` and verify changed commands |

The pre-commit hook runs formatting, `check:code` and staged documentation
checks, plus the dependency audit when dependency files are staged. Continuous
integration runs `bun run check`, focused Docker-backed runner subsets and the
E2E, component and distribution suites on every pull request; the remaining
runner lifecycle cases run in the local full gate. See [developer checks](docs/developer-checks.md) for each suite.

## Pull requests

- One pull request per issue or topic; link it with `Fixes #123`.
- Fill in the pull request template: summary, evidence and merge danger.
- Squash-merge pull requests into `master` (linear history is required); the
  title then becomes the commit subject, so follow the commit style below.

## Commit style

Use conventional commits: `type: description`, with an optional scope
(`type(scope): description`).

```text
feat: add shared automation for Claude Codex and OpenCode
docs: clarify scoped agent instructions
refactor: isolate User writes and improve agent tooling
```

Common types: `feat` `fix` `docs` `chore` `refactor` `test` `ci` `perf`.

## Issues and labels

- Open issues with the forms: bug report, feature request or question. Report
  vulnerabilities privately, as described in [SECURITY.md](SECURITY.md).
- Triage labels drive the agent workflow; [triage labels](docs/agents/triage-labels.md)
  maps each triage role to its label.

| Label                                          | Meaning                                                             |
| ---------------------------------------------- | ------------------------------------------------------------------- |
| `P0`                                           | Emergency: data loss, security bypass, crash loop, or unusable core |
| `P1`                                           | High: blocks planned work, needs attention soon                     |
| `P2`                                           | Medium: normal priority                                             |
| `P3`                                           | Low: nice to have                                                   |
| `impact: security`                             | Security boundary, credentials, authorization, or sensitive data    |
| `impact: data-loss`                            | Can lose, corrupt, or silently drop persisted data                  |
| `impact: availability`                         | Crash, hang, restart loop, or process-level outage                  |
| `dependencies`                                 | Updates or remediates a dependency                                  |
| `bug` `enhancement` `documentation` `question` | Issue type                                                          |

## Code of conduct

Participation is governed by the [code of conduct](CODE_OF_CONDUCT.md).

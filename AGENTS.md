# Agent Instructions

## Agent skills

### Issue tracker

Issues and specs are tracked in GitHub Issues for `danilomartinelli/vibecoding-starter-js` using the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the default triage labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, and `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Use a single-context layout: root `GLOSSARY.md` and `docs/adr/`, created lazily as terms and decisions are resolved. See `docs/agents/domain.md`.

### Validation

Before declaring code changes ready, run `bun run check:full`. Pre-commit hooks
run the infrastructure-free checks; see `docs/developer-checks.md` for setup,
individual suites and documentation-only validation.

### Review before commit

Review the intended staged changes, including new files, before committing.
Follow `.agents/skills/code-review/SKILL.md` to pin the base and index snapshot
for both reviewers; re-review fixes before committing the reviewed snapshot.

### Focused exploration

Start with issue summaries or `rg` matches, then read the selected issue or code
range. See `docs/agents/issue-tracker.md` for bounded GitHub queries.

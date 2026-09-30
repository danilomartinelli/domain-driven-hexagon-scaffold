---
name: implement
description: 'Implement a piece of work based on a spec or set of tickets.'
disable-model-invocation: true
---

Implement the work described by the user in the spec or tickets.

Before exploring issues, source or registry metadata, follow the bounded-reading
workflow in `docs/agents/issue-tracker.md`. For a parent issue, start with the
acceptance criteria referenced by the selected child.

Use /tdd where possible, at pre-agreed seams.

Run typechecking and focused tests during implementation. Before declaring code
ready, run the complete gate documented in `AGENTS.md` and
`docs/developer-checks.md`.

Stage only the intended changes, including new files. Run `bun --bun lint-staged`
before capturing the review snapshot so formatting is included. Use /code-review
in staged mode before committing. Resolve findings, rerun affected checks and
review the updated snapshot.

Commit the reviewed changes to the current branch. If the commit hook changes
the snapshot, review that difference before publishing.

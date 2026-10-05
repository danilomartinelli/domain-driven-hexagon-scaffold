---
name: implement
description: 'Implement an issue through validation, commit, push and pull request.'
disable-model-invocation: true
---

Implement the work described by the user in the spec or tickets.

Before exploring issues, source, tools or registry metadata, follow
`docs/agents/issue-tracker.md#conventions`. Start with the selected child's
acceptance criteria, then use structural navigation or scoped text searches
to select the source ranges needed for the decision, and read those ranges.
When a read is truncated, page it with the helpers in
`docs/agents/bounded-output.md`.

Before the first test, formatter or Nx task, complete the setup in
`docs/developer-checks.md#setup`. Continue when the checkout's pinned Bun and
local Nx/Prettier executables run successfully. Recheck after changing the
lockfile or dependency manifests.

Use /tdd where possible. The seams named by the selected issue's acceptance
criteria are pre-agreed; agree any other seam with the user.

When the work preserves existing behavior, first write tests at its external
seams and run them against the base with `bun run characterize -- <files>`;
they must pass there and after your change.

During implementation, follow `docs/developer-checks.md#focused-feedback` for
the focused test, typecheck and lint loop, including command exit statuses and
affected component suites for infrastructure/runner changes.

Stage only the intended changes, including new files. Changes already in the
worktree when the session started belong to the commit only when the selected
issue requires them; leave the rest unstaged and report that decision. Run
`bun --bun lint-staged` before capturing the review snapshot so formatting is
included. Use /code-review
in staged mode before committing. Resolve findings, rerun affected checks and
review the updated snapshot.

After both reviews have no unresolved findings, run the final gate documented
in `AGENTS.md` and `docs/developer-checks.md` against that reviewed snapshot.
Do not overlap this final gate with reviews that may require changes. If the
gate requires a fix, rerun affected checks, stage and review the new snapshot,
then rerun the final gate.

For an issue implementation, finish the publication authorized by `AGENTS.md`
unless the user requested a narrower endpoint. Verify that the index still
matches the reviewed tree, commit on the current branch using the repository's
commit style, then verify that the committed tree matches. If a hook changes
the snapshot, review and validate that difference before publishing.

Use /pr for the [publication workflow](../pr/SKILL.md#publication): push, create
or update the PR against the main branch, retain accurate closing/related issue
references, verify the published state, follow CI to completion for the published
head and update any existing session evidence.
Report the PR URL and distinguish local validation from remote CI. A user request
to stop before commit or publication takes precedence; report that endpoint.

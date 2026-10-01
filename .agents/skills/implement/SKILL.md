---
name: implement
description: 'Implement a piece of work based on a spec or set of tickets.'
disable-model-invocation: true
---

Implement the work described by the user in the spec or tickets.

Before exploring issues, source or registry metadata, follow
`docs/agents/issue-tracker.md#conventions`. For a parent issue, start with the
acceptance criteria referenced by the selected child. Locate files and matching
lines first, then read selected ranges with the existing bounded helper:

```sh
bun run search -- --files scripts/tests
bun run search -- 'withCleanup' scripts/tests
bun scripts/search.ts --read --max-bytes=6000 -- scripts/tests/cleanup.ts 1 35
```

Adapt the scope, query and ranges to the task. For incomplete reads, follow the
continuation and outer-tool budget rules in
`docs/agents/issue-tracker.md#conventions` before relying on missing content.

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
the focused test, typecheck and lint loop, including command exit statuses.

Stage only the intended changes, including new files. Run `bun --bun lint-staged`
before capturing the review snapshot so formatting is included. Use /code-review
in staged mode before committing. Resolve findings, rerun affected checks and
review the updated snapshot.

After both reviews have no unresolved findings, run the final gate documented
in `AGENTS.md` and `docs/developer-checks.md` against that reviewed snapshot.
Do not overlap this final gate with reviews that may require changes. If the
gate requires a fix, rerun affected checks, stage and review the new snapshot,
then rerun the final gate.

Commit the reviewed and validated changes to the current branch. Verify the
index still matches the reviewed tree before committing. If the commit hook
changes the snapshot, review and validate that difference before publishing.

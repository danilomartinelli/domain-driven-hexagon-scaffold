---
name: code-review
description: 'Review the changes since a fixed point (commit, branch, tag, or merge-base) along two axes: Standards (does the code follow this repo''s documented coding standards?) and Spec (does the code match what the originating issue/spec asked for?). Runs both reviews in parallel sub-agents and reports them side by side. Use when the user wants to review a branch, a PR, work-in-progress changes, or asks to "review since X".'
---

Two-axis review of committed or staged changes against a fixed point:

- **Standards**: does the code conform to this repo's documented coding standards?
- **Spec**: does the code faithfully implement the originating issue / spec?

Both axes run as **parallel sub-agents** so they don't pollute each other's context, then this skill aggregates their findings.

The issue tracker should have been provided to you. If `docs/agents/issue-tracker.md` is missing, tell the user to run `/setup-matt-pocock-skills`.

## Process

### 1. Pin the fixed point

Use the fixed point supplied by the task, or its configured target branch. Ask
only when neither is known. Resolve it to a commit SHA and capture the merge-base
with `HEAD`; both reviewers receive the same resolved comparison.

Choose the review subject:

- **Committed changes** (branch/PR review): capture the `HEAD` SHA and use
  `git diff <merge-base-sha> <head-sha>`.
- **Staged changes** (implementation/pre-commit review): stage the intended files,
  including new files, and run `bun --bun lint-staged` before the snapshot. Check
  `git status --short` for intended files still unstaged or untracked. Capture
  the immutable index tree with `git write-tree` and use
  `git diff <merge-base-sha> <index-tree-sha>`. This includes branch commits since
  the base plus the staged changes. Use `HEAD` as the fixed point when only the
  pending commit is in scope.

Record the chosen mode, both object IDs, exact diff command and
`git log <fixed-point-sha>..HEAD --oneline`. Require a non-empty diff and pass
these values to both reviewers. No preliminary commit is needed.

Keep the index at the reviewed tree until both reviewers return; working-tree
fixes may start immediately, because reviewers read snapshot content with
`git show <index-tree-sha>:<path>`. Distinguish worktree test results from
validation of that snapshot.
After fixes, restage, rerun affected checks and review the updated snapshot.
Before committing, verify `git write-tree` still matches the reviewed tree.
If a hook changes the committed tree, review the resulting difference before
publishing.

### 2. Identify the spec source

Use the explicit specification or user request for this task first. Otherwise,
look for issue references in the reviewed commits and fetch only those issues
using `docs/agents/issue-tracker.md`, then look for a matching spec file under
`docs/`, `specs/`, or `.scratch/`. Ask if none is available; an explicitly absent
spec is reported as "no spec available" on the Spec axis.

### 3. Identify the standards sources

Anything in the repo that documents how code should be written, such as `CODING_STANDARDS.md` or `CONTRIBUTING.md`.

On top of whatever the repo documents, the Standards axis always carries the **smell baseline** below: a fixed set of Fowler code smells (_Refactoring_, ch.3) that applies even when a repo documents nothing. Two rules bind it:

- **The repo overrides.** A documented repo standard always wins; where it endorses something the baseline would flag, suppress the smell.
- **Always a judgement call.** Each smell is a labelled heuristic ("possible Feature Envy"), never a hard violation. Like any standard here, skip anything tooling already enforces.

Each smell reads _what it is_ → _how to fix_; match it against the diff:

- **Mysterious Name**: a function, variable, or type whose name doesn't reveal what it does or holds. → rename it; if no honest name comes, the design's murky.
- **Duplicated Code**: the same logic shape appears in more than one hunk or file in the change. → extract the shared shape, call it from both.
- **Feature Envy**: a method that reaches into another object's data more than its own. → move the method onto the data it envies.
- **Data Clumps**: the same few fields or params keep travelling together (a type wanting to be born). → bundle them into one type, pass that.
- **Primitive Obsession**: a primitive or string standing in for a domain concept that deserves its own type. → give the concept its own small type.
- **Repeated Switches**: the same `switch`/`if`-cascade on the same type recurs across the change. → replace with polymorphism, or one map both sites share.
- **Shotgun Surgery**: one logical change forces scattered edits across many files in the diff. → gather what changes together into one module.
- **Divergent Change**: one file or module is edited for several unrelated reasons. → split so each module changes for one reason.
- **Speculative Generality**: abstraction, parameters, or hooks added for needs the spec doesn't have. → delete it; inline back until a real need shows.
- **Message Chains**: long `a.b().c().d()` navigation the caller shouldn't depend on. → hide the walk behind one method on the first object.
- **Middle Man**: a class or function that mostly just delegates onward. → cut it, call the real target direct.
- **Refused Bequest**: a subclass or implementer that ignores or overrides most of what it inherits. → drop the inheritance, use composition.

### 4. Spawn both sub-agents in parallel

Use the configured `standards-reviewer` and `spec-reviewer` roles when the client
provides them. Their shared instructions live in `.agents/reviewers/`; otherwise
pass the same briefs below to generic sub-agents. Both receive the same pinned
comparison. The reviewers return findings without editing or publishing them.

**Standards sub-agent prompt** should include:

- The full diff command and commit list.
- The list of standards-source files you found in step 3, **plus the smell baseline from step 3** pasted in full (the sub-agent has no other access to it).
- The brief: "Report, per file/hunk where relevant, (a) every place the diff violates a documented standard: cite the standard (file + the rule); and (b) any baseline smell you spot: name it and quote the hunk. Distinguish hard violations from judgement calls: documented-standard breaches can be hard, but baseline smells are always judgement calls, and a documented repo standard overrides the baseline. Skip anything tooling enforces. Under 400 words."

**Spec sub-agent prompt** should include:

- The diff command and commit list.
- The path or fetched contents of the spec.
- The brief: "Report: (a) requirements the spec asked for that are missing or partial; (b) behaviour in the diff that wasn't asked for (scope creep); (c) requirements that look implemented but where the implementation looks wrong. Quote the spec line for each finding. Under 400 words."

If the spec is missing, skip the Spec sub-agent and note this in the final report.

### 5. Aggregate

Present the two reports under `## Standards` and `## Spec` headings, verbatim or lightly cleaned. Do **not** merge or rerank findings, because the two axes are deliberately separate (see _Why two axes_).

End with a one-line summary: total findings per axis, and the worst issue _within each axis_ (if any). Don't pick a single winner across axes: that's the reranking the separation exists to prevent.

## Why two axes

A change can pass one axis and fail the other:

- Code that follows every standard but implements the wrong thing → **Standards pass, Spec fail.**
- Code that does exactly what the issue asked but breaks the project's conventions → **Spec pass, Standards fail.**

Reporting them separately stops one axis from masking the other.

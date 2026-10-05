# Issue tracker: GitHub

Issues and specs for this repo live in [GitHub Issues](https://github.com/danilomartinelli/vibecoding-starter-js/issues). Use the `gh` CLI for all operations.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body-file <path>`. Write the exact Markdown body to a temporary file, preserving real newlines, and pass it with `--body-file`.
- **Read the selected issue**: `gh issue view <number> --json number,title,body,labels`. Fetch `gh issue view <number> --comments` when discussion or decisions are relevant.
- **List issue summaries**: `gh issue list --state open --limit 30 --json number,title,labels --jq '.[] | {number, title, labels: [.labels[].name]}'`. Narrow with `--label` or `--search` before fetching individual bodies.
- **Comment on an issue**: `gh issue comment <number> --body-file <path>`
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`

Keep exploration output bounded: list identifiers first, then read selected
records. For tool discovery, filter by the required capability and inspect only
the matching tool names/descriptions; do not dump the whole registry. For source
structure and relationships, first select paths or symbols from scoped search
matches, then use CodeGraph's `codegraph_explore` MCP tool with that symbol and a
small `maxFiles` budget, or the bounded CLI:
`bun run explore --max-files=3 -- 'runCommand'`. Setup and client activation are in
[agent automation](automation.md#codegraph).

Use `rg --files` or `rg -n '<symbol>' <directory>` for exact text and paths,
then read the relevant line range. Use TypeScript navigation for semantic
definitions and references. Check CodeGraph staleness warnings against the live
file before relying on them; if the graph is unavailable, use scoped searches.
Read a whole file when the question requires its complete contract. If a result
is truncated, narrow the question before paging through a large answer; continue
the read only when the missing content affects the decision, paging it with the
bounded `explore` and `search` helpers in [bounded output](bounded-output.md).

For a child issue, read the child first. Save a long parent body under `.context/`
(`gh issue view <parent> --json body --jq .body > .context/parent-<parent>.md`),
locate its headings with `rg -n '^##'`, and read the referenced acceptance criteria
and relevant decision ranges. Expand to other sections only when they affect the
selected work.

For registry metadata, select only fields needed for the decision (version,
engines and peer dependencies); save a full response under `.context/` when the
CLI cannot select fields. Keep large issue bodies and registry manifests in
separate outputs.

Infer the repo from `git remote -v`; `gh` does this automatically when run inside a clone.

## CI observation

After publishing, run `bun run ci:watch -- --pr=<number>` from the repository.
Use `--repo=<owner/name>` to select a repository explicitly. The helper reads
GitHub through `gh`; it does not push, rerun jobs, edit the PR or merge.

It follows this repository's `CI` workflow for the PR branch and current head,
waits for run registration, reports only changes in active stages, and restarts
observation when the head changes. Before reporting a terminal result it checks
the head and latest run attempt again. Polling defaults to 15 seconds and has a
30-minute observation deadline; `--interval-ms` and `--timeout-ms` override them.

Keep the watcher attached to one execution session and consume only the new
output returned when waiting on that session. Use one bounded session wait per
observation, up to 45 seconds, without a separate sleep call. Keep required
periodic user updates brief when the stage is unchanged; add detail for stage
changes, failures or decisions. Each `[ci:progress]` line is a stage change; the terminal line
and exit status identify completion, with durable evidence in the reported JSON
file. Read that evidence once after completion. This keeps observation in the
watcher instead of repeatedly reading its accumulated output.

| Exit | Result        | Meaning                                              |
| ---- | ------------- | ---------------------------------------------------- |
| 0    | `passed`      | CI succeeded for the verified head                   |
| 1    | `failed`      | CI ran and finished unsuccessfully; inspect its logs |
| 2    | `unavailable` | GitHub access or response validation failed          |
| 3    | `blocked`     | CI needs action or completed without executing steps |
| 4    | `timed_out`   | Observation ended while CI remained pending          |

Only exit 0 records approval. `blocked` does not infer a billing or permissions
cause: inspect the linked run's annotations. Invalid CLI arguments also exit 2.

The terminal JSON observation is written atomically to
`.context/ci/pr-<number>.json`; `--output=<path>` selects another destination.
It includes the timestamp, observed heads, PR body and closing references, run,
jobs, outcome and exit status. Reference it when updating session evidence.
The observation does not establish local validation or a reviewed Git tree.

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external PRs as feature requests; `/triage` reads this flag.)_

When set to `yes`, PRs run through the same labels and states as issues, using the `gh pr` equivalents:

- **Read a PR**: `gh pr view <number> --comments` and `gh pr diff <number>` for the diff.
- **List external PR summaries**: `gh pr list --state open --limit 30 --json number,title,labels,author`. For selected PRs, fetch the association with `gh api repos/<owner>/<repo>/pulls/<number> --jq .author_association`; keep `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, or `NONE`. Read bodies/comments only for those candidates.
- **Comment / label / close**: `gh pr comment`, `gh pr edit --add-label`/`--remove-label`, `gh pr close`.

GitHub shares one number space across issues and PRs, so a bare `#42` may be either: resolve with `gh pr view 42` and fall back to `gh issue view 42`.

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a single issue with **child** issues as tickets.

- **Map**: a single issue labelled `wayfinder:map`, holding the Notes / Decisions-so-far / Fog body. `gh issue create --label wayfinder:map`.
- **Child ticket**: an issue linked to the map as a GitHub sub-issue (`gh api` on the sub-issues endpoint). Where sub-issues aren't enabled, add the child to a task list in the map body and put `Part of #<map>` at the top of the child body. Labels: `wayfinder:<type>` (`research`/`prototype`/`grilling`/`task`). Once claimed, the ticket is assigned to the driving dev.
- **Blocking**: GitHub's **native issue dependencies**, the canonical, UI-visible representation. Add an edge with `gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`, where `<blocker-db-id>` is the blocker's numeric **database id** (`gh api repos/<owner>/<repo>/issues/<n> --jq .id`, _not_ the `#number` or `node_id`). GitHub reports `issue_dependencies_summary.blocked_by` (open blockers only, the live gate). Where dependencies aren't available, fall back to a `Blocked by: #<n>, #<n>` line at the top of the child body. A ticket is unblocked when every blocker is closed.
- **Frontier query**: list the map's open children (`gh issue list --state open`, scoped to the map's sub-issues / task list), drop any with an open blocker (`issue_dependencies_summary.blocked_by > 0`, or an open issue in the `Blocked by` line) or an assignee; first in map order wins.
- **Claim**: `gh issue edit <n> --add-assignee @me`, the session's first write.
- **Resolve**: `gh issue comment <n> --body-file <path>`, then `gh issue close <n>`, then append a context pointer (gist + link) to the map's Decisions-so-far.

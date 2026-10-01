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
structure and relationships, use CodeGraph's `codegraph_explore` MCP tool with a
specific question and a small `maxFiles` budget (for example, 5), or its CLI:
`codegraph explore --max-files 5 'runCommand'`. Setup and client activation are in
[agent automation](automation.md#codegraph).

Use `rg --files` or `rg -n '<symbol>' <directory>` for exact text and paths,
then read the relevant line range. Use TypeScript navigation for semantic
definitions and references. Check CodeGraph staleness warnings against the live
file before relying on them; if the graph is unavailable, use scoped searches.
Read a whole file when the question requires its complete contract. If a result
is truncated, narrow the question before paging through a large answer; continue
the read only when the missing content affects the decision.

For bounded source searches and selected file ranges, use the repository helper:

```sh
bun run search -- --files scripts
bun run search -- 'assertTestEnvironment' database tests
bun run search --max-bytes=8000 -- 'invocation' node_modules/nx/dist/src/tasks-runner
bun scripts/search.ts --read --max-bytes=6000 -- src/apps/user/application/create-user.ts 20 54 src/apps/user/application/delete-user.ts 18 33
```

The helper previews long matching lines at 240 columns. Read mode accepts
`<file> <first-line> <last-line>` triples, emits `file:line:content` in argument
order, and reads inclusive positive ranges. Quote paths containing spaces.
Ranges extending past EOF stop at EOF. A missing file or malformed range fails
with exit 2; a selected line too large for the budget produces exit 125.

One invocation shares a 16,000 UTF-8 byte cap across stdout, stderr and status
text, plus a 10-second deadline, including all ranges in a read batch.
Use `bun scripts/search.ts` when the budget must exclude the package runner's
own command echo and error messages.
`--max-bytes=<n>` and `--timeout-ms=<n>` before `--` change those bounds.
Exit 125 marks incomplete output; exit 124 marks timeout. A full read page emits
`[search:resume] --resume=<range-index>:<line>` on stderr. Repeat the original
`--read` invocation with that option before `--`, keeping every original range
and the files unchanged. The zero-based range index identifies repeated or
overlapping ranges; the line is the first line not delivered. Each page reserves
room for its cursor inside the same byte cap. For example:

```sh
bun scripts/search.ts --read --max-bytes=6000 --resume=0:41 -- scripts/tests/search.test.ts 1 180
```

A single line that cannot fit the current page reports the minimum byte budget;
increase `--max-bytes` before retrying its cursor. An unchanged budget cannot make
progress on that line. If the numbered line plus diagnostic space exceeds the
maximum 1,048,576-byte page, reading fails explicitly without a cursor: whole-line
continuation is unavailable. Use a bounded excerpt or search preview for that
line. Search mode has no read cursor: narrow its path/pattern and retry.
Complete results retain ripgrep's 0/1/2 exit codes. Use the Git inventory
commands directly when a workflow requires every path, rather than a search preview.

For a child issue, read the child first. Save a long parent body under `.context/`
(`gh issue view <parent> --json body --jq .body > .context/parent-<parent>.md`),
locate its headings with `rg -n '^##'`, and read the referenced acceptance criteria
and relevant decision ranges. Expand to other sections only when they affect the
selected work.

Batch selected ranges in one paginated `--read` invocation. Return one page per
tool response, leaving room for the tool's own output wrapper. The helper's byte
cap cannot control an outer tool's token cap. If that outer response is cut, lower
`--max-bytes` and repeat the same page before advancing its cursor. Keep large issue
bodies and registry manifests in separate outputs.
For registry metadata, select only fields needed for the decision (version,
engines and peer dependencies); save a full response under `.context/` when the
CLI cannot select fields.

Infer the repo from `git remote -v`; `gh` does this automatically when run inside a clone.

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

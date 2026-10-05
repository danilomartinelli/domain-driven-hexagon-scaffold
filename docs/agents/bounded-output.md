# Bounded command output

Reference for the repository's `explore` and `search` helpers, reached from the
[exploration conventions](issue-tracker.md#conventions) when a result is
truncated or a read needs pages. Both cap output and resume through cursors.

## CodeGraph exploration

The CLI saves CodeGraph stdout/stderr and exit status under
`.context/codegraph/<capture-id>/`, then emits a page limited to 6,000 UTF-8 bytes
across both output streams. `--max-bytes=<n>` selects 512..1,048,576 bytes;
`--timeout-ms=<n>` selects a 1..60,000 ms command deadline (default 10 seconds).
Exit 125 with `[explore:resume]` means more saved output is available. Continue
with `bun run explore --resume=<capture-id>:<range>:<line>`, without repeating the
query. Pages reuse the saved result even if source files change; a fresh query
creates a new capture. Long lines report the minimum page size. A line exceeding
the maximum page must be inspected through a narrower read of the saved artifact.
Successful commands retain their complete output; commands exceeding the
8,000,000-character per-stream capture limit are stopped and recorded as
incomplete. Timeout and tool failures remain nonzero and appear in every page's
status; after the last page, the CLI returns the captured command's exit status.
For a budget excluding the package runner's command echo, use
`bun --no-env-file scripts/explore.ts` with the same options.

## Searches and selected ranges

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

One invocation shares a 6,000 UTF-8 byte cap across stdout, stderr and status
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

Batch selected ranges in one paginated `--read` invocation. Return one page per
tool response, leaving room for the tool's own output wrapper. The helper's byte
cap cannot control an outer tool's token cap. If that outer response is cut, lower
`--max-bytes` and repeat the same page before advancing its cursor.

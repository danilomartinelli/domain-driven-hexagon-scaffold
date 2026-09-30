# Retrospective follow-up: Nx guardrails and dependency audits

The three improvements approved after issue #17 are implemented locally:

- A direct Bun `check:workspace` suite runs before the Nx quality commands.
  It exercises the public CLI in an isolated source copy with private workspace
  links and cache paths. Source graph edges and typecheck cache invalidation
  are behavioral assertions. Command deadlines terminate owned process groups;
  output overflow is an explicit failure.
- `audit:changed` runs in the full gate and, with `--staged`, in pre-commit.
  It covers root/workspace manifests and Bun lockfiles, comparing the branch to
  its base or examining the pending index. Every applicable audit queries the
  registry. Vulnerabilities return 1; unavailable registry/Git results return 2.
  Mixed index/worktree dependency content is rejected before querying.
- The `implement` skill now points to the bounded-reading workflow. Its existing
  tracker guide explains how to select child-relevant parent sections and
  registry fields, save large responses and recover from truncated output.

## Validation

Bun 1.4.2 on macOS arm64 was used. Frozen installation remained valid without
new dependencies. The guardrail suite has eleven passing cases:

- Command timeout kills its descendant; excessive output cannot become a
  truncated successful result.
- The supported Nx command discovers the actual source/command graph edges.
- A warmed typecheck cache rejects invalid library source, shared TypeScript
  configuration and decorator-fixture types, then accepts restored source.
- Non-dependency changes skip the registry in branch and staged modes.
- Lockfile and workspace manifest changes trigger fresh native Bun requests,
  including committed, staged and untracked changes and development packages.
- A local HTTP registry supplies an advisory and an unavailable response; the
  public audit command distinguishes them as statuses 1 and 2.
- An unavailable Git base, mixed staged dependency edits and a staged lockfile
  deletion with an untracked replacement cannot pass as completed audits.
- Git inventories above 64,000 characters preserve every copied source file and
  still filter excluded directories. Large untracked, staged and committed file
  lists skip audits only when no dependency files changed; changed manifests
  still query the registry.

PR #37 review reproduced a shared output-limit failure in workspace creation and
audit change detection using temporary repositories with long file inventories.
The same scenarios passed below the 64,000-character threshold. Git commands now
opt into complete output while other subprocesses keep the existing limit and
all commands retain their deadlines. The two regressions pass with large lists.
The developer guide also distinguishes the application-only `test:debug` command
from the explicit package inspector targets.

The audit tests use real Git repositories, native `bun audit --json` and a local
registry implementing the advisory endpoint, including Bun's compressed request.
They do not access the external registry. Git environment exported by a parent
hook is removed from commands in disposable repositories.

Negative configuration probes disabled Nx source analysis and removed dependency
inputs from typecheck. The respective new tests failed, demonstrating detection
of the two regressions observed during the original implementation. Both probes
were restored before final validation.

`NX_SKIP_NX_CACHE=true bun run check:full` passes the guardrail suite, strict
lint/types, architecture, formatting, conditional live audit, 20 application/core
unit tests, three Docker lifecycle checks and 11 application E2E/integration
cases. The real audit reports `audit:clean`. The workspace suite explicitly
uses its isolated cache even when the surrounding gate disables cache, so it
continues to verify invalidation rather than bypassing that contract.

The staged hook and review workflow remain authoritative for publication. No
CI workflow or deployment is added. Local command output and negative-probe
logs are retained under `.context/`.

# Script and runner instructions

This directory owns repository checks and environment orchestration. Read the
[database workflow](../docs/database.md) before changing provisioning or cleanup,
and [developer checks](../docs/developer-checks.md) for the validation contract.

## Environment lifecycle

- Derive resource identity from the workspace/run manifest and verify Docker
  owner labels before adopting or shutting down resources. Preserve sibling
  environments and development volumes; shutdown must not delete volumes.
- Keep test-target validation strict: conflicting shell overrides must fail
  before connecting. Development intentionally permits shell overrides.
- Preserve command, interruption and cleanup statuses. Attempt owned cleanup
  after failed or interrupted runs; cleanup failure must fail an otherwise
  successful run. Keep logs and results under `.context/test-runs/`. The
  development workflow (`dev`) cleans up only a failed infrastructure startup;
  ready infrastructure outlives its migrations and applications until `dev:down`.
- Keep provisioning, live tests and environment execution uncached in Nx
  (`cache: false`). Test run IDs cannot be reused; development runs can be
  prepared again using their existing manifest.

## Subprocesses and fixtures

- Use [runCommand](lib/command.ts) for bounded repository-check subprocesses.
  Preserve deadline enforcement, process-group termination and explicit failure
  on output overflow. Complete Git file inventories use `maxOutput: Infinity`.
  The environment runner has its own lifecycle-aware command session.
- Read Nx's resolved project graph with [readProjectGraph](lib/nx-graph.ts);
  tests pass `isolated: true` so the checkout's Nx data stays untouched.
- Use [createWorkspace](tests/workspace-fixture.ts) for checks that mutate source
  or configuration. Keep workspace package links and Nx caches inside the
  temporary copy; leave the checkout and its cache untouched.
- Clean temporary workspaces in `finally`. Infrastructure fixtures use
  [withCleanup](tests/cleanup.ts) to attempt every cleanup and preserve both
  operation and cleanup failures.

## Validation

Run from the repository root:

- `bun run check:workspace` covers repository guardrails without Docker.
- `bun run test:tooling` covers the real Docker environment lifecycle.

These complement the root validation gates. When changing runner behavior,
exercise failure, interruption and resource-preservation cases as applicable.

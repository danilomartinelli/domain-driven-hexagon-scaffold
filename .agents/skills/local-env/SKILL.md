---
name: local-env
description: Prepare, run, inspect or stop this workspace's owned development or disposable test environment when explicitly requested.
disable-model-invocation: true
---

Use [the database workflow](../../../docs/database.md) as the command contract;
read [runner instructions](../../../scripts/AGENTS.md) and finish
[developer setup](../../../docs/developer-checks.md#setup) first.

Choose development for a persistent local application, or test for disposable
validation. Reuse the user's selected development run; allocate a fresh test run
ID for each new environment. If an existing manifest belongs to this workspace,
inspect its status before continuing. Do not display generated credentials.

- **Ordinary E2E:** prefer `bun run test:e2e`, optionally with a test-name pattern.
  It owns preparation, migrations, seeds, tests and cleanup.
- **Development:** prefer `bun run dev` (`make dev`, optionally `--run=<id>`).
  It prepares the run, applies every application's migrations and watches both
  services, leaving infrastructure running after they exit. It does not seed:
  for a new volume, seed each application once through `env:exec`; seeds cannot
  be repeated safely. Use `env:prepare`/`env:exec` for one service. Keep a
  requested development server running and report how to stop its selected run.
- **Repeated test work:** follow the prepared-test commands with the same run ID
  through prepare, migration, seed and execution. Retain the preload for direct
  test-file invocation. Always attempt `env:down` after success, failure or
  interruption. Test run IDs cannot be reused after shutdown.
- **Shutdown:** call `env:down` with the selected environment and run, or
  `bun run dev:down` (`make down`) for development. Preserve sibling runs and
  development volumes; never substitute global Docker cleanup.

Keep migrations and seeds inside `env:exec`. Conflicting test target overrides
must fail before connecting. Report the environment/run, successful lifecycle
steps, command status and cleanup status. Logs under `.context/test-runs/` are
local evidence, not material to publish with credentials.

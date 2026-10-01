---
name: nx-workspace
description: Inspect this Bun/Nx workspace's project graph, resolved targets and project ownership before selecting or diagnosing Nx tasks.
---

Read [the workspace guide](../../../docs/nx-workspace.md) for ownership and the
[setup checks](../../../docs/developer-checks.md#setup) before invoking Nx.
Always use the installed CLI through `bun run nx`, which disables implicit dotenv
loading and the daemon. These repository rules also apply to upstream Nx advice.

Use bounded JSON queries appropriate to the question:

```sh
bun run nx show projects --json
bun run nx show project user --json
bun run nx show projects --withTarget test --json
bun run nx graph --print
bun run nx show projects --affected --base=origin/master --head=HEAD --json
```

Resolved project output includes inferred configuration. Use that output before
claiming a target exists; read the relevant source configuration when explaining
why it is configured that way. For uncommitted changes, choose the matching Nx
affected options rather than assuming `--head=HEAD` includes them.

User and Wallet own their business code independently; `core` and `nest-support` hold
technical packages. Check entry-point and cycle rules in `src/packages/AGENTS.md`.
Keep Nx Cloud disabled. Discover current applications with
`bun run nx show projects --type app --json`; confirm generator availability
against the installed plugins.

The minimal Nx MCP supplies current Nx documentation. CLI output and the local
guides provide workspace and task information. For actual execution,
use the companion [task skill](../nx-run-tasks/SKILL.md).

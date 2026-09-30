# Agent automation

The repository configures Claude Code, Codex and OpenCode. Skills live in
`.agents/skills/`; Codex and OpenCode discover that directory natively. Claude
Code uses the existing `.claude/skills/` links. Review criteria live in
[the shared Standards](../../.agents/reviewers/standards.md) and
[Spec](../../.agents/reviewers/spec.md) instructions. Each client retains its
configured model and reasoning defaults.

## Capability mapping

| Capability                          | Claude Code                       | Codex                                                       | OpenCode                                   |
| ----------------------------------- | --------------------------------- | ----------------------------------------------------------- | ------------------------------------------ |
| Library documentation               | Context7 in `.mcp.json`           | Context7 in `.codex/config.toml`                            | Context7 in `opencode.json`                |
| Migration and environment workflows | `/create-migration`, `/local-env` | `$create-migration`, `$local-env`                           | `/create-migration`, `/local-env` commands |
| Formatting after edits              | `PostToolUse` for Edit/Write      | `PostToolUse` for apply_patch                               | Native Prettier formatter                  |
| Review roles                        | `.claude/agents/`                 | `.codex/agents/`                                            | `agent` entries in `opencode.json`         |
| TypeScript navigation               | Official TypeScript LSP plugin    | `typescript-navigation` skill and `typescript:query` CLI    | Native TypeScript LSP                      |
| Nx                                  | Official `nx` plugin              | Shared `nx-workspace` and `nx-run-tasks` skills plus Nx MCP | The same shared skills plus Nx MCP         |

The migration and environment skills are explicit-only in Claude Code and Codex.
OpenCode's skill schema does not enforce those fields, so its command wrappers
load them on request and the skill instructions retain the explicit-request
boundary. No shared skills are copied into a third directory.

## Setup and activation

Complete [developer setup](../developer-checks.md#setup). The LSP plugin needs an
executable on the client process's PATH; it uses the project's TypeScript version.
The validated CLI prerequisite is:

```sh
npm install --global typescript-language-server@6.0.1
typescript-language-server --version
```

This server requires Node 22.22.2 or newer. CLI tools already use the developer's
runtime manager. Restart clients launched before installation so they see the
executable and new project configuration.

Claude Code installs its two enabled project plugins from the declared official
marketplaces. To install them explicitly on another machine:

```sh
claude plugin marketplace add anthropics/claude-plugins-official
claude plugin marketplace add nrwl/nx-ai-agents-config
claude plugin install --scope project typescript-lsp@claude-plugins-official
claude plugin install --scope project nx@nx-claude-plugins
```

Codex loads project configuration only for a trusted checkout. The roles are
registered explicitly in `.codex/config.toml`, with their config layers in
`.codex/agents/`, for compatibility with Codex CLI 0.156.0. Its hook runtime
also requires review/trust of the exact hook definition through `/hooks`; changed
definitions require review again. OpenCode loads `opencode.json` from the project.
These are native client activation requirements, not extra application gates.

In linked Git worktrees, Codex CLI 0.156.0 loads hook declarations from the main
checkout's matching `.codex/` directory, even though other project settings come
from the worktree. This is [the client's worktree behavior](https://github.com/openai/codex/blob/rust-v0.156.0/codex-rs/config/src/loader/mod.rs),
so `/hooks` can show no project hooks while this change exists only on a branch.
Make the configuration available in the main checkout through the normal
merge/update workflow, then review the hook in `/hooks`. Use `git worktree list`
to identify that checkout. Do not copy hook trust records between checkouts.

If your shell or launcher sets `OPENCODE_DISABLE_PROJECT_CONFIG=true`, OpenCode
ignores both the project config and commands. This environment has that override.
Use the repository launcher to enable project configuration for just this process:

```sh
bun run agents:opencode
bun run agents:opencode debug config --pure
```

It preserves other global/profile settings. Debug configuration can contain
private values from those settings; do not publish its complete output.

Context7 uses its public HTTP endpoint. Each client forwards `CONTEXT7_API_KEY`
from its process environment as the `CONTEXT7_API_KEY` header; without the
variable, requests use the small anonymous quota ("Monthly quota exceeded").
Export the key privately, outside the repository; a client opened from the Dock
inherits `launchctl` environment, not your shell's. Query library versions from
`package.json` rather than assuming the newest documentation matches.

Nx's official plugin and `nx mcp` bootstrap the official Nx MCP package on first
use. The shared skills use `bun run nx`, preserve explicit environment selection,
and keep Nx Cloud disabled. The Claude plugin inherits `NX_DAEMON=false` and
`NX_LOAD_DOT_ENV_FILES=false` from project settings. Nx skills are informed by the
[official integration](https://github.com/nrwl/nx-ai-agents-config) and adapted to
[this workspace's contracts](../nx-workspace.md).

## Formatting and review

All clients call [the same formatter](../../scripts/format-agent-edit.ts). It
formats only paths named by the edit, uses the existing Prettier configuration,
skips deleted/unsupported/ignored files, and refuses paths resolving outside the
workspace. Codex patches can contain several additions, edits and moves. Failures
are reported rather than hidden. Shell-based edits are outside the Edit/Write and
apply_patch hooks; format those paths explicitly before review.

Run lint-staged before pinning the review snapshot as required by
[code-review](../../.agents/skills/code-review/SKILL.md). Reviewers receive the same
immutable comparison and return findings to the parent; formatting must finish
before the snapshot is captured. Full code validation remains `bun run check:full`.

Codex has no configured native LSP adapter. Its equivalent supports semantic
definitions and references through the installed TypeScript language service:

```sh
bun run typescript:query definition src/main.ts 1 10
bun run typescript:query references src/main.ts 1 10
bun run typecheck
```

Positions are 1-based; results are JSON locations. Queries use the root TypeScript
project to cover both packages and their callers. They do not mutate files.

## Inspect the loaded configuration

```sh
claude plugin list
codex mcp list
bun run agents:opencode debug agent standards-reviewer --pure
bun run agents:opencode debug agent spec-reviewer --pure
bun run agents:opencode debug skill --pure
bun run agents:opencode debug lsp diagnostics src/main.ts --pure
bun test ./scripts/tests/agent-automation.test.ts
```

Use Codex `/hooks` to inspect activation. Its review roles are registered under
`[agents.standards-reviewer]` and `[agents.spec-reviewer]` in the project config;
the shared `code-review` skill requests those roles when supported.
Configuration inspection does not exercise a model or prove that an
external MCP service is reachable; verify those separately when diagnosing tools.

Sources: [Claude hooks](https://code.claude.com/docs/en/hooks),
[Codex hooks](https://learn.chatgpt.com/docs/hooks),
[Codex agents](https://learn.chatgpt.com/docs/agent-configuration/subagents),
[OpenCode skills](https://opencode.ai/docs/skills/),
[OpenCode formatters](https://opencode.ai/docs/formatters/),
[OpenCode LSP](https://opencode.ai/docs/lsp/),
[Context7](https://github.com/upstash/context7).

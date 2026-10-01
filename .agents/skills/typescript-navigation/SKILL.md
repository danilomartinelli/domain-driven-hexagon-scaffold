---
name: typescript-navigation
description: Find TypeScript definitions and references or diagnose types using the workspace compiler, including clients without native LSP support.
---

Use native TypeScript LSP when available (Claude Code and OpenCode). Codex can use
the same project's TypeScript language service through the read-only CLI below.
Complete [developer setup](../../../docs/developer-checks.md#setup) first.

```sh
bun run typescript:query definition src/apps/user/main.ts 1 10
bun run typescript:query references src/apps/user/main.ts 1 10
bun run typecheck
```

Replace the file and 1-based line/column with the symbol being inspected. The CLI
returns JSON locations using the root TypeScript project, so references include
application, packages and tooling. An empty list means no matching symbol result,
not proof that dynamic/reflection-based uses are absent. Runtime framework wiring
still needs focused source inspection. Use `bun run search -- <rg arguments>` to
locate those seams and `bun run lint:boundaries` to validate legal imports.

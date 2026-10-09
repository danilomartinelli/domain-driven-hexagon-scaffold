# Deep modules

Private Bun workspace packages and nested Nx projects live here. `core/` owns
framework-free technical primitives; `nest-support/` owns framework helpers,
`rabbitmq/` consumer/publisher lifecycles and failure-queue operations, `integration-contracts/` versioned
event envelopes and `capabilities/` application declaration parsing, discovery and
the shared readiness snapshot contract.
Business code belongs to its application: `src/apps/user` or `src/apps/wallet`.
`example/` is a starter template to copy or delete. See [the Nx guide](../../docs/nx-workspace.md).

```text
src/packages/
  <name>/              # one package per immediate child; no nested packages
    index.ts           # public entry point
    client.ts          # another optional public entry point
    lib/impl.ts        # private implementation
    tests/example.test.ts
    tests/fixtures.ts  # private test support
```

**Entry points:** Import only through a package's entry points (its root files).
Declare explicit `package.json` exports for those entry points and import them
using the workspace package name. Every subfolder is private, regardless of its name or depth. Discourage barrel
files: expose several small entry points instead of re-exporting a whole subtree
through one index. An interface should hide useful behavior, keeping callers
independent of the implementation.

**Consumer dependencies:** Declare `@starter/<name>: "workspace:*"` in each
consumer's `package.json`. Applications use the root manifest; their runtime
package imports belong in its `dependencies`. Update the lockfile with
`bun install`, then repeat the [setup checks](../../docs/developer-checks.md#setup).

**Inside a package:** Its production files may import each other freely,
including nested implementation files. Test folders remain private to tests.
Existing layer rules still apply independently of this convention.

**Tests:** Files under `tests/` exercise behavior through root entry points.
They may import their own test fixtures and any package's entry points, but no
package's implementation or another package's fixtures. Production files must
not import tests or fixtures. Run `bun run test:unit` for package and core tests
without infrastructure.

**No cycles:** Dependencies must be acyclic, including type-only imports and
code outside this folder. Run `bun run lint:boundaries`; it checks `src`, `tests`,
`scripts` and `database`, and is included in `check:code`, `check:full` and pre-commit.

# Deep modules

New packages live here; the existing `src/modules` structure remains until the
planned Nx migration. `example/` is a starter template to copy or delete.

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
Every subfolder is private, regardless of its name or depth. Discourage barrel
files: expose several small entry points instead of re-exporting a whole subtree
through one index. An interface should hide useful behavior, keeping callers
independent of the implementation.

**Inside a package:** Its production files may import each other freely,
including nested implementation files. Test folders remain private to tests.
Existing layer rules still apply independently of this convention.

**Tests:** Files under `tests/` exercise behavior through root entry points.
They may import their own test fixtures and any package's entry points, but no
package's implementation or another package's fixtures. Production files must
not import tests or fixtures. Run `bun run test:unit` for package and core tests
without infrastructure.

**No cycles:** Dependencies must be acyclic, including type-only imports and
code outside this folder. Run `bun run lint:boundaries`; it checks `src`, `tests`
and `scripts`, and is included in `check:code`, `check:full` and pre-commit.

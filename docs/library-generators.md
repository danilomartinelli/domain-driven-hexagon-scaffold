# Private library generators

The local `@starter/generators` Nx plugin supplies `ts-lib` and `nest-lib`.
Run commands from the repository root after the [setup checks](developer-checks.md#setup).
Use a unique lowercase kebab-case name; the destination is always
`src/packages/<name>`, with an explicit `@starter/<name>` public export.

```sh
bun run nx generate @starter/generators:ts-lib text-normalization --dry-run
bun run nx generate @starter/generators:ts-lib text-normalization
bun run nx generate @starter/generators:nest-lib text-adapter
```

| Preset                         | Layer         | Responsibility                                      |
| ------------------------------ | ------------- | --------------------------------------------------- |
| `ts-lib`                       | `core`        | Framework-free shared technical behavior            |
| `nest-lib` (default)           | `adapter`     | Nest-facing technical adapters; no generated module |
| `nest-lib --layer=composition` | `composition` | Register and export an existing injectable provider |

Business entities, use cases and persistence models remain application-owned.
The Nest preset rejects `--layer=core`. Composition requires both `--provider`
and `--providerImport`, pointing to a real class exported by a private workspace
package. For example, after implementing and exporting `TextAdapter` from
`@starter/text-adapter`:

```sh
bun run nx generate @starter/generators:nest-lib text-composition \
  --layer=composition \
  --provider=TextAdapter \
  --providerImport=@starter/text-adapter
```

This creates `TextCompositionModule` with that provider in `providers` and
`exports`; it does not invent providers or their constructor dependencies.
Supply providers whose dependencies are already available, and extend the
composition when more wiring is needed. Private subfolder imports and
undeclared package entry points are rejected. No empty module is generated.

## Generated files and consumption

Each library has a private package manifest, `project.json`, `tsconfig.json`,
`bunfig.toml`, `index.ts` and usage/test documentation. The Nx tags are
`scope:shared` and `type:core`, `type:adapter` or `type:composition`.
Implement useful behavior behind the public interface in private subfolders;
the generator creates no CRUD, use case or artificial assertion.

Generation formats its files and runs Bun installation after Nx commits the
virtual tree, updating the lockfile and local workspace links. Repeat the
[setup checks](developer-checks.md#setup) after these dependency changes.
Declare `"@starter/<name>": "workspace:*"` in each consumer's dependencies
(the root manifest for applications), then run `bun install` again. Import
through the declared entry point, never through a package's private folders.

```sh
bun run nx show project text-normalization --json
bun run nx run text-normalization:lint
bun run nx run text-normalization:typecheck
bun run nx run text-normalization:test
bun run lint:boundaries
```

The native Bun `test` and `test-watch` targets use only that library's `tests/`
directory, without infrastructure or preload. **No tests exist initially**:
Bun reports that absence and exits nonzero. Add meaningful tests through public
exports alongside real behavior before considering the library ready. Lint
and type targets reuse the strict repository configuration.

The file-level boundary rules recognize every package tagged `type:core`, as
well as the original core. Both direct Nest imports and indirect escapes
through adapters are rejected. App domain/application code may consume these
framework-free cores. Nx additionally checks ownership, declared dependencies
and cycles. Tests retain the repository's public-entry-point restrictions.
Declared public exports may be unconsumed while a library is being developed;
the orphan check still rejects unexported, unused files.

## Dry runs, collisions and verification

`--dry-run` previews file changes without writing the destination, installing
packages or changing the lockfile. Existing destinations and duplicate project
names fail before writes, including with `--force`. Paths, nested packages and
invalid presets are rejected.

```sh
bun run nx run generators:test
```

The uncached [generator suite](../scripts/tests/library-generators.test.ts) uses
an isolated scratch copy and its own installed dependencies and Nx cache. It
generates both kinds and a provider composition, consumes their public exports,
checks discovery, formatting, lint, types, native Bun behavior and architecture,
and proves both legal core consumption and rejected framework/adapter imports.
It also verifies dry runs, collisions and absent-test reporting. Cleanup removes
only that run's temporary directory in `finally`; it never provisions Docker
or copies development environment files. The suite runs in `test:unit`,
`check`, `check:full` and CI through the plugin's `test` target.

Application generation (`nest-app`) remains a separate issue.

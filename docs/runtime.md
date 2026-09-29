# Native Bun application and tests

Use **Bun 1.4.2** from the repository root. Application TypeScript, decorators,
dependency injection metadata, path aliases and Slonik's ESM imports execute
directly, without producing `dist/`:

```sh
bun install --frozen-lockfile
cp .env.example .env # first setup only; preserve an existing .env
bun run docker:env
bun run migration:up
bun run start:dev
```

The server listens on port 3000: REST at `/v1/users`, OpenAPI at `/docs` and
`/docs-json`, GraphQL at `/graphql`. `start:dev` uses `bun --watch` to restart
the complete application on source changes. `bun run start` runs once;
`start:debug` adds Bun's inspector; `start:prod` sets `NODE_ENV=production` and
runs the same source. Deployments need the source and runtime dependencies, not
an emitted JavaScript build. CLI and messaging controllers remain registered
examples; they still have no CLI bootstrap or messaging transport.
See [adapter compatibility](adapters.md) for the Nest/Apollo versions, CLI
command definition, and the limits of each example. The existing start scripts
continue to execute the full application directly under Bun.

The shared dotenv 18 loader selects `.env.test` only when `NODE_ENV=test`,
otherwise `.env`; shell-provided values take precedence. Its new startup banner
is disabled so database status output remains readable. Bun's automatic env
loading stays disabled in `bunfig.toml`. See [database settings](database.md#postgresql-and-connections)
before using custom ports or database names. Application HTTP port remains 3000.

`bun run typecheck` runs TypeScript **6.0.3** with `noEmit`. Native execution is
not type checking. Type-only imports are explicit so Bun does not try to load
interfaces as runtime values, while injectable classes retain decorator metadata.
Module resolution uses `bundler`/`preserve`; alias paths are relative to the
tsconfig. `useDefineForClassFields: false` retains the existing field assignment
semantics, including inherited DTO properties initialized by base constructors.
Application, tests, database scripts and tool configurations are now checked with
strict settings. See [developer checks](developer-checks.md) for the individual
type, lint, format and architecture commands.

## Gherkin through the real application

Prepare the disposable database using the workflow delivered in issue #4:

```sh
bun run docker:tests
bun run migration:up:tests
bun test
```

No seed command is required. Tests clear users and wallets before the run and
after each case, including any seeded fixtures. The migration history is kept.
Use only a disposable validation database, never development data.

`bunfig.toml` discovers the renamed `*.test.ts` files and preloads the test setup.
Bun sets `NODE_ENV=test` by default; an explicitly different value is rejected.
The preload loads `.env.test` and rejects database names without a standalone
`test` or `tests` prefix/suffix, including shell-provided overrides, **before**
importing the application or opening a pool. Bun's automatic env loading remains
disabled so a parent `bun run` cannot import development settings first.

`jest-cucumber` **4.5.0** receives `describe` and `test` from `bun:test`; hooks and
assertions also use Bun. The existing feature text and observable assertions
are unchanged: valid creation/listing, five invalid-input rows, and deletion.
Nest, its HTTP server, validation, event handlers and PostgreSQL are real.
The application pool also performs cleanup; `afterAll` awaits `app.close()`,
which awaits pool shutdown. Setup failures after application creation also
close the application.

```sh
bun test tests/user/create-user/create-user.test.ts # six cases
bun test tests/user/delete-user/delete-user.test.ts # one case
bun run test:e2e # same seven cases
bun run test:watch
bun run test:cov
bun run test:debug # inspector pauses before execution
```

Run one test process at a time against `ddh_tests`; shared table cleanup is not
compatible with concurrent processes or Bun's `--concurrent`/`--randomize` flags.
Migrations are explicit, not performed by a test hook. To stop and remove the
disposable database, follow the [database cleanup instructions](database.md#seeds-and-cleanup).

## Persistence and transaction review

Slonik **49.10.10**, its matching `@slonik/*` packages, Zod **4.6.5** and the
resolved `pg` **8.23.0** replace Slonik 31 and `nestjs-slonik`. The global local
`DatabaseModule` provides one awaited `createPool()` result and awaits `end()`
on application shutdown. Repositories and the direct listing query inject this
same token. The default Slonik pg driver is used; no alternate database adapter
is introduced. Slonik declares Node >=24; execution of this application is
verified on the explicitly selected Bun 1.4.2 runtime.

Queries use `sql.type(schema)` for rows, `sql.fragment` for query composition,
and `sql.unsafe` for parameterized writes without returned rows. Here `unsafe`
means untyped results, not interpolated SQL strings. The provider's async result
parser validates rows and returns parsed values, including coerced timestamps;
schemas are not merely TypeScript annotations. Mappers still validate writes.

The transaction remains the existing request-context flow:

```text
HTTP request -> isolated AsyncLocalStorage context
  CreateUserService -> userRepo.transaction(connection)
    context.transactionConnection = connection
    userRepo.insert -> connection.query
      await publishEvents -> await eventEmitter.emitAsync
        wallet handler -> walletRepo.insert -> same connection.query
    callback resolves -> Slonik commits
    callback rejects -> Slonik rolls back
    finally clears the context connection
```

Both repositories' `pool` accessor prefers the request's transaction connection
over the injected pool. The local `RequestContextMiddleware` starts a distinct
`AsyncLocalStorage.run()` store for each HTTP request, including GraphQL, using
Express 5's named wildcard route. There is no shared fallback store outside a
request. The asynchronous wallet listener returns the insertion promise.
Nest event-emitter **12.0.1** suppresses listener errors by default, so the wallet
listener explicitly sets `suppressErrors: false`. `emitAsync`, aggregate
publication, repository insertion and the transaction callback all await it.
The repository rethrows failures (mapping
uniqueness errors to the existing conflict type), so commit cannot precede the
wallet write. This is implementation review of the existing top-level workflow,
not a general redesign of context or transaction ownership.

**The seven cases do not prove atomic rollback.** They contain no forced wallet
failure or rollback assertion. They are the application's actual cases, distinct
from the isolated Bun/Gherkin probes recorded during specification. See the
[original execution record](validation/issue-5-runtime.md) and the
[Nest upgrade record](validation/issue-6-adapters.md).

Jest's runner, transformation configs, `ts-jest`, `ts-node`, `ts-loader`, the
runtime alias hook and Nest's build toolchain have been removed. `@types/jest`
remains for jest-cucumber's runner interface. The architecture analyzer and ESLint have also been updated. `tsconfig-paths`
remains only through dependency-cruiser's resolver plugin; it is not used to
start the application or tests. The old ESLint cache dependency on `rimraf`
has been removed.

The Nest/adapters upgrade is documented in [adapter compatibility](adapters.md).
Strict lint/type settings and architecture tooling are documented in
[developer checks](developer-checks.md). The [dependency inventory](dependencies.md)
and [combined validation record](validation/issue-8-upgrade.md) cover the completed
remediation, clean frozen install and real application checks. As required by
[ADR 0001](adr/0001-modernize-with-bun.md), future goals
remain: an Nx monorepo; removing the domain's context/framework/event-publication
coupling; and completing startup and executable CLI/messaging examples.

References: [Slonik runtime validation](https://github.com/gajus/slonik#runtime-validation),
[jest-cucumber runner injection](https://github.com/bencompton/jest-cucumber/blob/main/docs/AdditionalConfiguration.md#configure-test-runner),
[Bun lifecycle hooks](https://bun.com/docs/test/lifecycle).

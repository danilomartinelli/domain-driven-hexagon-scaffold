# Dependency inventory and maintenance

Application/tool dependencies were reviewed against npm registry metadata on
September 29, 2026 for issue #8, with Nx additions rechecked for issue #17.
The dependencies below have a consumer.
Versions already upgraded in #4–#7 were rechecked alongside the remaining
helpers. Direct versions are pinned; `bun.lock` records the complete resolution.
Use **Bun 1.4.2**, including for package installation, application execution,
tests and migrations.

## Application dependencies

| Package                             | Version  | Consumer / decision                                                                                                                            |
| ----------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `@nestjs/common`, `@nestjs/core`    | 12.1.1   | Application modules, injection, middleware, controllers and bootstrap                                                                          |
| `@nestjs/platform-express`          | 12.1.1   | Nest HTTP adapter using Express 5                                                                                                              |
| `@nestjs/microservices`             | 12.1.1   | Existing message-controller decorators; no transport/bootstrap added                                                                           |
| `@nestjs/cqrs`                      | 12.1.0   | Command/query buses and handlers                                                                                                               |
| `@nestjs/event-emitter`             | 12.0.1   | Awaited in-process domain publication                                                                                                          |
| `@nestjs/swagger`                   | 12.0.2   | OpenAPI DTO metadata and `/docs`                                                                                                               |
| `@nestjs/graphql`, `@nestjs/apollo` | 14.0.3   | Code-first schema, resolvers and Apollo driver                                                                                                 |
| `@apollo/server`                    | 5.5.1    | Server loaded by the Nest Apollo driver                                                                                                        |
| `@as-integrations/express5`         | 1.1.2    | Apollo driver's Express middleware integration                                                                                                 |
| `graphql`                           | 16.14.2  | Latest 16.x; Apollo Server 5.5.1 requires `^16.11.0`, excluding registry latest 17.0.2                                                         |
| `class-transformer`                 | 0.5.1    | Nest DTO transformation; current stable version                                                                                                |
| `class-validator`                   | 0.15.1   | DTO validation and Nest validation pipe                                                                                                        |
| `reflect-metadata`                  | 0.2.2    | Decorator metadata at application/test bootstrap                                                                                               |
| `rxjs`                              | 7.8.2    | Nest interceptors and reactive framework contracts                                                                                             |
| `slonik`                            | 49.10.10 | Local pool provider, repositories and SQL tokens                                                                                               |
| `zod`                               | 4.6.5    | Persistence result schemas and mapper validation                                                                                               |
| `dotenv`                            | 18.0.4   | Updated from 16.6.1; legacy application and database tooling `.env` / `.env.test` loaders                                                      |
| `env-var`                           | 7.5.0    | Required database setting validation; pin latest stable instead of the old minimum range                                                       |
| `nanoid`                            | 6.0.1    | Updated from 3.3.19; existing `nanoid(6)` request correlation IDs                                                                              |
| `oxide.ts`                          | 1.1.0    | Existing Result/Option contracts; pin latest stable instead of the old minimum range                                                           |
| `commander`                         | 15.0.0   | Existing CLI command definition; no executable CLI added                                                                                       |
| `cors`                              | 2.8.6    | GraphQL middleware restoring the existing browser CORS behavior                                                                                |
| `amqplib`                           | 2.2.0    | Wallet's manual-ACK RabbitMQ consumer and confirmed failure retention; includes TypeScript declarations; checked for #22 on September 30, 2026 |

All selections other than GraphQL were the registry's latest stable versions.
Nest packages have mutually compatible Nest 12 peers; Apollo/Express integration
supports Apollo 5 and Express 5. Slonik's default pg driver uses pg 8.23.0.
Upstream Node engine requirements are not a claim of a Node runtime here:
the actual application and tools are validated under the explicitly chosen Bun.
See [adapter limits](adapters.md) and [runtime/transaction details](runtime.md).

## Development dependencies

| Package              | Version | Consumer / decision                                                                                                 |
| -------------------- | ------- | ------------------------------------------------------------------------------------------------------------------- |
| `@nestjs/testing`    | 12.1.1  | Real Nest application in the existing test setup                                                                    |
| `@types/express`     | 5.0.6   | HTTP request and middleware declarations                                                                            |
| `@types/cors`        | 2.8.19  | GraphQL CORS middleware declarations                                                                                |
| `@types/bun`         | 1.4.2   | Native runner/runtime declarations matching the fixed runtime                                                       |
| `@types/node`        | 24.19.0 | Node-compatible API declarations; latest 24.x matching the current LTS line, not Current 26.x                       |
| `@types/jest`        | 30.0.0  | jest-cucumber's injected-runner declarations; no Jest runner installed                                              |
| `@types/supertest`   | 7.2.1   | Typed HTTP agent used by the existing cases                                                                         |
| `@types/pg`          | 8.23.1  | Migration-history rows and pg client declarations                                                                   |
| `supertest`          | 7.3.0   | Real HTTP requests in the existing tests                                                                            |
| `jest-cucumber`      | 4.5.0   | Gherkin parsing and native Bun runner injection                                                                     |
| `node-pg-migrate`    | 9.0.0   | SQL migration creation/history/transactions/advisory lock                                                           |
| `pg`                 | 8.23.0  | Direct migration and seed client; also used transitively by Slonik                                                  |
| `typescript`         | 6.0.3   | Strict static checking only; 7.0.2 is outside typescript-eslint's `>=4.8.4 <6.1.0` and the analyzer's supported API |
| `eslint`             | 10.11.0 | Strict lint CLI                                                                                                     |
| `@eslint/js`         | 10.0.1  | Base flat-config rules for ESLint 10                                                                                |
| `typescript-eslint`  | 8.71.0  | `strictTypeChecked` rules; supports ESLint 10 and TypeScript 6                                                      |
| `prettier`           | 3.9.9   | Independent formatting CLI                                                                                          |
| `dependency-cruiser` | 18.4.0  | Existing architecture checks and graph generation                                                                   |

All selections other than TypeScript and the Node LTS declarations were latest
stable. `bun outdated` therefore lists only GraphQL, TypeScript and `@types/node`;
these are compatibility/LTS choices, not accepted vulnerability exceptions.
Sources: [typescript-eslint support](https://typescript-eslint.io/users/dependency-versions/),
[Node release status](https://nodejs.org/en/about/previous-releases),
[Apollo 5.5.1 registry manifest](https://registry.npmjs.org/@apollo%2fserver/5.5.1).

## Transitive remediation

The initial audit reported [GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq)
in uuid 9.0.1 and 10.0.0. The unused direct `uuid` and `@types/uuid` declarations
were removed: entity/command/event IDs already use the runtime's `randomUUID`.
The latest jest-cucumber still declares vulnerable uuid ranges. Explicit root
overrides replace them with **uuid 14.0.2**, the current stable fixed version:

```text
jest-cucumber 4.5.0 -> uuid 14.0.2 (declares ^10.0.0)
jest-cucumber -> @cucumber/gherkin 28.0.0 -> @cucumber/messages 24.1.0
  -> uuid 14.0.2 (declares 9.0.1)
  -> reflect-metadata 0.2.2 (declares 0.2.1)
jest-cucumber -> glob 13.0.6 (declares ^10.3.10)
node-pg-migrate 9.0.0 -> glob 13.0.6 (declares ~13.0.0)
```

The metadata review also found deprecated glob 10.5.0 and reflect-metadata
0.2.1 through that Gherkin tree. Overrides select glob 13.0.6 and reflect-metadata
0.2.2, removing their deprecated copies. jest-cucumber/messages consume uuid's
named `v4()` without options; Bun supports their CommonJS imports of the newer
ESM package. Gherkin feature discovery uses glob's retained `sync(pattern)` API.
The existing real application cases and migration workflow validate the resulting
integration. These overrides deliberately cross upstream declared ranges; they
are dependency fixes verified on Bun 1.4.2, not advisory suppressions or a claim
of compatibility with other runtimes. Remove them when upstream declares a
maintained, safe resolution and the individual checks pass without overrides.

The complete final tree contains 458 distinct package/version pairs, including
development dependencies; registry metadata reports no deprecated versions.
`bun audit` checks 436 package names and reports no known vulnerabilities,
without production-only filtering, advisory ignores or accepted exceptions.
These are dated registry results, not a guarantee against future advisories.

Remaining helpers have upstream consumers: `jiti` belongs to node-pg-migrate's
supported format loader (accepted in ADR 0001); `tsconfig-paths` belongs to
dependency-cruiser's resolver, and `interpret`/`rechoir` to its configuration
loader. None executes application TypeScript, tests or SQL migrations.
`@types/jest` brings declaration-support packages such as `expect`/`jest-mock`;
`@cucumber/messages` still declares its own `@types/uuid` 9.0.8. These are not
direct application helpers or a Jest runner. There is no `jest`, `jest-cli`,
`jest-runner`, `ts-jest`, `ts-node`, `ts-loader`, webpack build or emitted app.

Inspect and audit the current resolution with separate commands:

```sh
bun pm ls --all
bun why uuid
bun why glob
bun why reflect-metadata
bun why axios
bun outdated
bun audit
```

Next objectives remain **Nx monorepo; correction of hexagonal coupling;
completion of CLI and messaging examples**, as required by
[ADR 0001](adr/0001-modernize-with-bun.md).

## Nx baseline additions

Nx and `@nx/devkit` are pinned together at 23.2.1. The devkit supplies the
virtual tree and installation callback for the private `@starter/generators`
workspace plugin; Prettier formats generated files. `@nx/nest` 23.2.1 excludes Nest 12
from its peer range, so repository-owned run-command targets preserve the
application versions. Private `@starter/core`, `@starter/nest-support`,
`@starter/example` and `@starter/config` packages use explicit exports and
workspace links. See [the workspace guide](nx-workspace.md).

Nx brings `smol-toml` 1.6.1, affected by
[GHSA-7w5x-hrqm-74c2](https://github.com/advisories/GHSA-7w5x-hrqm-74c2).
The root override pins stable **1.9.0**, beyond the advisory's first fixed
version 1.7.1. No advisory is ignored. The conditional `audit:changed` gate runs in `check:full` and for staged
dependency changes in pre-commit; registry failures block with a distinct status.
Use `bun audit` for an unconditional manual query.

The September 30, 2026 audit also identified three advisories in the resolved
`brace-expansion` 5.0.9 pinned by Nx:
[nested recursion](https://github.com/advisories/GHSA-qhr7-859c-m2p7),
[comma parsing](https://github.com/advisories/GHSA-6j4f-fj2g-mc7p), and
[quadratic expansion](https://github.com/advisories/GHSA-q2hr-2g5m-vwhr).
The root override pins **5.0.12**, which includes all three fixes. This stays
within the same major version but overrides Nx's exact 5.0.9 dependency;
the full gate validates the resulting resolution without advisory ignores.

The same day's audit reported seven advisories in Axios 1.18.1, which Nx 23.2.1
pins exactly. The root override selects **Axios 1.20.0**, the first fixed 1.x
release for all seven: prototype-pollution gadgets in
[fetch options](https://github.com/advisories/GHSA-vh66-26gq-q6x8),
[the default HTTP method](https://github.com/advisories/GHSA-9fr6-4gfg-395g), and
[form serialization](https://github.com/advisories/GHSA-x97p-jq2g-jp4f);
denial of service in
[data URI parsing](https://github.com/advisories/GHSA-c29m-xwm3-cm6r),
[proxy bypass host normalization](https://github.com/advisories/GHSA-mghh-pgcx-3jjj), and
[HTTP/2 session errors](https://github.com/advisories/GHSA-542g-h47m-68v8); and
[HTTP/2 DNS/proxy control bypass](https://github.com/advisories/GHSA-3pq3-5fj3-cg6v).
This overrides Nx's exact dependency while retaining Axios's major version.
Keep the override until Nx resolves a fixed version without it and the audit
and full gate pass with that resolution.

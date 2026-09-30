# Adapter compatibility and example limits

Issue #6 upgrades the application to Nest 12 on **Bun 1.4.2**. Run the same
individual install, database, start, and test commands in [the runtime guide](runtime.md).
All adapters remain registered in `AppModule` / `UserModule`; no separate CLI
entry point or microservice transport has been added.

## Dependency selection

Checked the npm registry's stable tags and published peer ranges on 2026-09-29,
then checked every installed required peer of the selected Nest/Apollo packages.
The versions below are pinned in `package.json` and resolved in `bun.lock`.
These projects use stable major lines rather than a separate LTS release tag.

| Integration                                                 | Selected version | Compatibility checked                                                                                   |
| ----------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------- |
| Nest common, core, platform-express, microservices, testing | 12.1.1           | Matching Nest `^12.0.0`; RxJS `^7.1.0`                                                                  |
| Nest CQRS                                                   | 12.1.0           | Nest `^12.0.0`; RxJS `^7.2.0`                                                                           |
| Nest event-emitter                                          | 12.0.1           | Nest `^11.0.0 \|\| ^12.0.0`                                                                             |
| Nest Swagger/OpenAPI                                        | 12.0.2           | Nest `^12.0.0`; TypeScript `^5.5.0 \|\| ^6.0.0`                                                         |
| Nest GraphQL / Apollo driver                                | 14.0.3           | Nest `^12.0.0`; driver requires Apollo Server `^5.0.0`                                                  |
| Apollo Server                                               | 5.5.1            | GraphQL `^16.11.0`                                                                                      |
| Express integration                                         | 1.1.2            | `@as-integrations/express5`: Express `^5.0.0`, Apollo `^4.0.0 \|\| ^5.0.0`; Nest resolves Express 5.2.1 |
| GraphQL                                                     | 16.14.2          | Latest stable 16; GraphQL 17.0.2 is outside Apollo Server's peer range                                  |
| Commander                                                   | 15.0.0           | No Nest peer dependency; the small local provider supplies Nest injection                               |
| Validation / transformation                                 | 0.15.1 / 0.5.1   | Nest common and mapped-types peer ranges                                                                |
| reflect-metadata / RxJS                                     | 0.2.2 / 7.8.2    | Shared Nest/GraphQL/CQRS peer ranges                                                                    |

Nest and Apollo publish Node engine requirements; this repository deliberately
runs their ESM packages on Bun 1.4.2. Application startup, schemas, database
lifecycle and the existing native tests provide the runtime evidence, rather
than treating Node engine metadata as a Bun support guarantee.

The resolved tree no longer contains `apollo-server-core`,
`apollo-server-express`, the old `apollo-server-*` packages,
`subscriptions-transport-ws`, `graphql-playground-*`, `nestjs-console` or
`nestjs-request-context`. No subscriptions were implemented by the application.
`nestjs-console` 10 still only declares support through Nest 11; a local
Commander definition avoids another Nest discovery/bootstrap wrapper for this
unfinished example. Request context is now a small local AsyncLocalStorage
middleware, with an explicit Express 5 route matcher.

## Existing contracts

- **REST:** `POST /v1/users` accepts email, country, postalCode and street and
  returns `{ id }`; `GET /v1/users` returns the existing paginated response;
  `DELETE /v1/users/:id` retains its response and error handling. Validation,
  command/query delegation, repository ports and mappers are preserved.
- **OpenAPI:** `/docs` and `/docs-json` still expose the same operations, request
  and response schemas. Swagger 12 adds automatic controller tags and places
  query examples within their parameter schemas; these are documentation changes.
- **GraphQL:** `/graphql` generates the same code-first SDL: `create(input:
CreateUserGqlRequestDto!)` and `findUsers(options: String!)`. The existing
  `options` argument remains a string; this upgrade does not redesign that
  educational example into a typed filter or JSON parser. The browser IDE is
  now GraphiQL, supplied by Nest GraphQL 14. GraphQL retains its wildcard CORS
  policy through explicit `cors()` middleware in `AppModule`, before Apollo:
  responses include `Access-Control-Allow-Origin: *`, and `OPTIONS /graphql`
  preflights return 204. REST does not enable CORS. Error payloads and accepted
  HTTP request formats have the migration differences described below.
- **CLI:** the injectable `CreateUserCliController.createCommand()` returns a
  Commander `new` command with subcommand
  `user <email> <country> <postalCode> <street>`. Its async action returns
  `createUser(...)`, which constructs the same `CreateUserCommand`, awaits
  `CommandBus.execute`, unwraps the result and logs the ID. Nothing calls
  `parseAsync()` or starts a CLI application. A future bootstrap still needs
  application initialization, context setup and awaited cleanup.
- **Messaging:** `@MessagePattern('user.create')` still accepts
  `CreateUserRequestDto`, awaits the same command bus, unwraps the result and
  returns `IdResponse`. There is no connected microservice, transport, or
  message-context lifecycle. Framework registration is not end-to-end execution.

CQRS is initialized with `CqrsModule.forRoot()`, and handlers supply their
command/query type to the new conditional handler interfaces. Domain classes
and bus payloads remain unchanged.

## GraphQL client migration

The unchanged SDL does not imply identical error payloads or HTTP transport
defaults. In line with [ADR 0001](adr/0001-modernize-with-bun.md), this upgrade
keeps the current Nest/Apollo error formatting, CSRF protection and batching
defaults; it does not install a legacy `formatError` compatibility layer.

| Case                                                                                | Previous behavior                                                                | Current behavior and client action                                                                                                                                                                                                        |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Input rejected by the global `ValidationPipe`                                       | `extensions.code: "BAD_USER_INPUT"`; validation details in `extensions.response` | `extensions.code: "BAD_REQUEST"`; details in `extensions.originalError`. Read `statusCode`, `message`, `error`, `correlationId` and `subErrors` there. These resolver errors still use HTTP 200 with GraphQL `errors` and `data: null`.   |
| Unhandled resolver error, including duplicate email                                 | Development responses exposed `extensions.exception.correlationId`               | Apollo no longer includes `extensions.exception`. Duplicate email still returns `INTERNAL_SERVER_ERROR`; clients cannot rely on a correlation ID in that error response. The validation correlation ID described above remains available. |
| GET query without a non-simple `Content-Type` or preflight header                   | Accepted with the former default CSRF setting                                    | HTTP 400. Send a non-empty `apollo-require-preflight` or `x-apollo-operation-name` header, or use a JSON POST with `Content-Type: application/json`.                                                                                      |
| `text/plain` or `application/x-www-form-urlencoded` POST without a preflight header | Accepted by the previous integration                                             | HTTP 400 from CSRF prevention. Send a JSON object with `Content-Type: application/json`.                                                                                                                                                  |
| Array of operations in one JSON POST                                                | HTTP operation batching accepted                                                 | HTTP 400: `Operation batching disabled.` Send one operation object per HTTP request.                                                                                                                                                      |

A normal JSON POST remains supported. Restoring CORS lets a browser on another
origin complete its preflight; it does not disable Apollo's CSRF checks or enable
HTTP batching. See [Apollo's CORS/CSRF guide](https://www.apollographql.com/docs/apollo-server/security/cors)
and [migration from Apollo Server 3](https://www.apollographql.com/docs/apollo-server/migration-from-v3).

## Request isolation and transaction participation

The middleware enters a fresh `AsyncLocalStorage` store for HTTP/GraphQL
correlation, and the interceptor assigns the request ID. Database connections
are no longer stored there. CQRS handlers map commands and explicit metadata
into plain User use cases; CLI and message adapters validate their DTOs before
delegating, including when called without HTTP context.

The use cases own `UserWriteTransaction` and explicitly request persistence
and fact recording inside its atomic scope. The Slonik adapter binds User and
Wallet repositories to the same local connection and awaits temporary Wallet
coordination and in-process dispatch. Repositories only persist; they never
publish facts. Exceptions reject the transaction callback without any ambient
connection cleanup. The database provider still awaits pool creation and shutdown.

Dispatch includes generated publication identity plus explicit operation time,
correlation and causation as a separate listener argument. It remains before
commit, so arbitrary listener side effects cannot be rolled back. This temporary
bridge must be replaced by an outbox and independent Wallet consumption at the
asynchronous cutover. See the [write-path explanation](runtime.md#persistence-and-transaction-review).

Remaining work follows [ADR 0002](adr/0002-adopt-nx-with-nest-and-bun.md):
application-owned read ports and independent services with durable messaging.
CLI bootstrap remains outside that migration scope. See [developer checks](developer-checks.md)
for the complete validation gate.

References: [Nest 12 migration guide](https://docs.nestjs.com/migration-guide),
[Nest GraphQL installation](https://docs.nestjs.com/graphql/quick-start),
[Apollo Server migration](https://www.apollographql.com/docs/apollo-server/migration),
[Nest event error handling](https://docs.nestjs.com/techniques/events),
[Commander command/action API](https://github.com/tj/commander.js).

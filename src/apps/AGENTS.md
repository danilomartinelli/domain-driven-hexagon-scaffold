# Application instructions

Each child directory is an independently runnable Nest/Bun application and its
own Nx project. Read [the Wallet guide](../../docs/wallet.md) before changing
`wallet/` and [the User guide](../../docs/user.md) before changing `user/`. Adding an application: complete every item of
[the checklist](../../docs/adding-an-application.md).

- An application imports only its own files and shared packages through their
  entry points. Never import another application or database/environment tooling from production code. Nothing outside an
  application imports its implementation. `bun run lint:boundaries` enforces this.
- Keep `domain/` and `application/` plain TypeScript: they own their ports and
  result models. Controllers and resolvers call application use cases and map
  results; they never import `database/`.
- `application.json` declares the application's name and its independent
  `persistence`, `messaging` and `exposure` capabilities. Composition passes it
  to the readiness probes, composes business REST/GraphQL adapters only with
  exposure, and tooling discovers applications from it; a disabled
  capability has no configuration, adapters or readiness dependency. Never add
  a central list of application names.
- `composition.json` registers prepared integrations and each functionality
  group's capability requirements. Bind those same names through
  `composeApplication` at the composition boundary and run preflight before
  adapters or environment changes. Only explicitly exposed groups withdraw with
  exposure; unmet business requirements must fail. See
  [application compatibility](../../docs/application-compatibility.md).
- Configuration comes from the application's own environment variables; do
  not load dotenv files. With persistence declared, migrations and seeds live in
  the application's `database/` folder and are discovered from the declaration.
- `tests/unit/` needs no framework or infrastructure and runs in `test:unit`.
  `tests/component/` starts the real entry point against a provisioned run; its
  preload must validate the owned test environment before anything else.
  Infrastructure fixtures may import `scripts/tests/cleanup.ts` and the owned broker gate to attempt all
  owned cleanup and preserve failures; this exception is limited to test code.

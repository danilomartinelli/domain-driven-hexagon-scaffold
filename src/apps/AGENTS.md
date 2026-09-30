# Application instructions

Each child directory is an independently runnable Nest/Bun application and its
own Nx project. Read [the Wallet guide](../../docs/wallet.md) before changing
`wallet/`.

- An application imports only its own files and shared packages through their
  entry points. Never import another application, the transitional `src` tree,
  or database/environment tooling from production code. Nothing outside an
  application imports its implementation. `bun run lint:boundaries` enforces this.
- Keep `domain/` and `application/` plain TypeScript: they own their ports and
  result models. Controllers and resolvers call application use cases and map
  results; they never import `database/`.
- Configuration comes from the application's own environment variables; do
  not load dotenv files. Migrations and seeds live in the application's
  `database/` folder and are registered in `database/applications.ts`.
- `tests/unit/` needs no framework or infrastructure and runs in `test:unit`.
  `tests/component/` starts the real entry point against a provisioned run; its
  preload must validate the owned test environment before anything else.

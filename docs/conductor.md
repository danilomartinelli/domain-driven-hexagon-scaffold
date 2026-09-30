# Conductor workspaces

[Shared settings](../.conductor/settings.toml) configure dependency setup, the
development server, unit-test watch mode and archive cleanup. Conductor's Mac
app reads shared settings from the remote default branch, so merge them into
`master` before expecting automatic setup in new local workspaces. For the
current checkout, run the scripts below from the repository root.

## Setup

Install the Bun version in `.bun-version` and ripgrep on `PATH` before creating
a workspace. Setup runs the [developer tool checks](developer-checks.md#setup)
and `bun install --frozen-lockfile`, including Husky installation. It supports
local and cloud workspaces and does not require Docker. Setup failures retain
their exit status and output in the ignored `.conductor/setup.log`.

```sh
bash -o pipefail -c 'bash scripts/conductor/setup.sh 2>&1 | tee .conductor/setup.log'
```

The root [`.worktreeinclude`](../.worktreeinclude) tells Conductor which
gitignored files to copy from the repository's main checkout into new local
workspaces:

- Root `.env*` files, including `.env.local` and `.env.test.local`.
- Local credentials under `.secrets/` or `secrets/`.
- Local certificates and keys under `certs/local/`.
- Machine-specific `.conductor/settings.local.toml` overrides.

These paths remain ignored by Git; `.env.example`, `.env.*.example` templates
and the existing `.env.test` fixture remain versioned. Only ignored files are
eligible for copying, so tracked templates already arrive through Git. The
include file replaces Conductor's default Files to copy rule. Copying happens
when creating a workspace, not as continuous synchronization between workspaces.

No copied files are required for the isolated development environment; a copied
`.env` is used only by legacy commands outside the selected environment. Keep
credentials out of shared settings. Dependency installs, Nx caches and generated
`.context/test-runs/` manifests remain workspace-local.

## Run

Start Docker, then select **dev** in Conductor's Run menu:

```sh
bash scripts/conductor/run.sh
```

The local-only script requires `CONDUCTOR_IS_LOCAL=1` and `CONDUCTOR_PORT`.
It prepares the named development run `conductor`, applies pending migrations
and starts the Nest watch server at `http://localhost:$CONDUCTOR_PORT`
(Swagger at `/docs`). The app accepts `PORT` and defaults to 3000 outside this
script. Database/broker identities and ports are isolated by the existing
[workspace environment runner](database.md#isolation-and-configuration), so
different workspaces can run concurrently. Keep database/broker shell overrides
unset to use the generated targets.

Seeds remain explicit because they are not idempotent. To add the example user
and wallet once, while the development environment is running:

```sh
bun run env:exec --environment=development --run=conductor -- bun run seed:up
```

The **unit** Run entry executes `bun run test:watch` locally or in cloud
workspaces and requires no Docker. Cloud workspaces do not expose the local
development command or depend on `CONDUCTOR_PORT`.

## Stop and archive

On exit or interruption, the development script attempts to stop its owned
containers and network. It preserves application failure/interruption status
and fails if otherwise successful execution cannot clean up. Archive repeats
the same scoped cleanup locally, including after a forcibly killed process:

```sh
bash scripts/conductor/archive.sh
```

Cleanup preserves named development volumes and other runs, including the
manual `default` run. Restarting **dev** reuses its manifest and data, then
applies pending migrations. Archive does nothing in cloud workspaces. Logs and
credential-bearing manifests remain under `.context/test-runs/`; never commit
them. See the [database workflow](database.md) for ownership checks and recovery.

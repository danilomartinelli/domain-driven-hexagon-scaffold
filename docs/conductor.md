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
`.env` is used only by database tooling outside the selected environment. Keep
credentials out of shared settings. Dependency installs, Nx caches and generated
`.context/test-runs/` manifests remain workspace-local.

## Run

Start Docker, then select **dev** in Conductor's Run menu:

```sh
bash scripts/conductor/run.sh
```

The local-only script requires `CONDUCTOR_IS_LOCAL=1` and `CONDUCTOR_PORT`.
It prepares the named development run `conductor`, applies pending migrations
for both applications, then starts User on `CONDUCTOR_PORT` and Wallet on
`CONDUCTOR_PORT + 1` (each has Swagger at `/docs`). The environment variables
are `USER_HTTP_PORT` and `WALLET_HTTP_PORT`; ordinary preparation allocates them. Database/broker identities and ports are isolated by the existing
[workspace environment runner](database.md#isolation-and-configuration), so
different workspaces can run concurrently. Keep database/broker shell overrides
unset to use the generated targets.

Preparation also starts an owned Kong gateway with separately allocated proxy
and Admin ports. See [gateway URLs](database.md#gateway-urls) to print its exact
URLs with `--run=conductor`; User and Wallet retain separate GraphQL schemas.

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

### When archiving deletes the workspace directory

Retained volumes outlive the workspace, but its ignored manifest does not.
Restoring or reusing the workspace path without the original manifest generates
a new owner ID. The next **dev** run then fails with
`Refusing resource owned by another environment.` No repository command deletes
these volumes or adopts them under a new owner.

To keep the data, stop **dev**, run the archive script, and back up the entire
`.context/test-runs/<project>/` directory outside the workspace before archiving.
Keep that backup private: it contains database and broker credentials. Restore
it to the same workspace path before preparing **dev** again. If a failed
preparation already generated a replacement manifest, replace that run directory
with the original backup first.

To discard the data instead, stop **dev** and run the archive script while the
original manifest is still available. Record its project and owner without
printing credentials:

```sh
bun --no-env-file -e 'import { readEnvironment } from "./database/environment"; const { project, owner } = readEnvironment("development", "conductor"); console.log(JSON.stringify({ project, owner }, null, 2));'
```

Set `project` and `owner` to those recorded values, then list only that project's
volumes:

```sh
docker volume ls --filter "label=com.docker.compose.project=$project"
```

For each exact volume name from that list, set `volume` and verify both labels
before removing it. This permanently deletes that volume's data; the ordinary
stop/archive scripts continue to preserve it.

```sh
docker volume inspect "$volume" --format '{{json .Labels}}'
if [ "$(docker volume inspect "$volume" --format '{{index .Labels "com.docker.compose.project"}}')" = "$project" ] &&
  [ "$(docker volume inspect "$volume" --format '{{index .Labels "dev.starter.owner"}}')" = "$owner" ]; then
  docker volume rm "$volume"
fi
```

If the workspace has already been deleted, prefer restoring the original backup.
Without it, inspect the surviving volumes' project and owner labels and confirm
which archived workspace they belong to before recording those values for manual
removal. A newly generated manifest cannot authorize cleanup of the old volumes.
Keep volumes for other workspaces and runs, including `default`.

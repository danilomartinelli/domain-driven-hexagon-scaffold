# Single-host Compose operations

This reference runs independently selected Linux images on one Docker Compose
host. It supports short maintenance windows, manual certificates and manual
per-application PostgreSQL recovery. Use the checkout's pinned Bun and installed
dependencies for the operator commands; applications run entirely from their
images. Docker access is privileged host access. There is no cloud integration,
high availability, certificate renewal, automatic database reversal or deployment
from CI. Image publication is a separate action.

## Supply the installation

Keep one stable, untracked directory per installation. Do not copy its inventory
to a different path or remove it while retaining Docker resources. The directory
and name determine its Compose project; a random owner label fences its containers,
networks and volumes. Commands refuse foreign ownership and concurrent operators.
`down` never deletes volumes. Retain the directory and backups securely outside Git.

```sh
ops_dir="$PWD/.secrets/compose-reference"
install -d -m 700 "$ops_dir/secrets"
```

Create `deployment.json` inside that directory, replacing **each** placeholder
with its independently selected, available registry digest:

```json
{
  "name": "reference",
  "images": {
    "user": "ghcr.io/your-organization/user@sha256:<64 hexadecimal characters>",
    "wallet": "ghcr.io/your-organization/wallet@sha256:<64 hexadecimal characters>"
  },
  "https": { "bind": "0.0.0.0", "port": 443 }
}
```

There is no default tag. Preparation reads `application.json` from each selected
image and verifies its application name. Persistence adds one private database
and an owner-only migration command; messaging adds a shared private broker;
exposure adds Kong with the image's explicitly declared routes. An all-disabled
application needs no secrets, certificates, database identities or migrations,
and retains private operational HTTP. Omit `https` when no image enables exposure.

Supply these files in `secrets/`, only for enabled capabilities:

| File                     | Containers receiving it                                     |
| ------------------------ | ----------------------------------------------------------- |
| `<app>-admin-password`   | The owning PostgreSQL container only                        |
| `<app>-owner-password`   | Owning PostgreSQL and that application's one-shot migration |
| `<app>-runtime-password` | Owning PostgreSQL and that application's server             |
| `broker-password`        | RabbitMQ and messaging-enabled applications                 |
| `tls.crt`, `tls.key`     | Kong only                                                   |

The passwords are operator-supplied, nonempty UTF-8 text with no CR or NUL and at
most one trailing LF. Compose rendering rejects CRLF and repeated trailing newlines
before provisioning: shell entrypoints and application readers would otherwise
interpret different passwords. One optional trailing LF is removed by both.
PEM certificate/key files retain their multiline format. User and Wallet servers
and artifact migrations support `<SETTING>_FILE` instead of `<SETTING>`. Supplying both fails without logging their values. Generated
messaging applications accept their original `<PREFIX>_RABBITMQ_URL[_FILE]` or
the structured `RABBITMQ_*` settings used here.

Compose file secrets are bind mounts: host permissions must let each receiving
container's Unix user read its file. One portable arrangement is a host directory
mode `0700` with files mode `0444`; the protected parent restricts other host users
while the individually mounted files remain readable by Bun, PostgreSQL, RabbitMQ
and Kong. Do not depend on Compose `uid`/`gid`/`mode` remapping for file sources.
See [Compose secrets](https://docs.docker.com/compose/how-tos/use-secrets/) and
[file-secret permissions](https://docs.docker.com/reference/compose-file/services/#secrets).
Use an operator-supplied certificate whose SAN covers the public hostname and a
matching unencrypted PEM key. Issuance and renewal remain operator responsibilities.
No secret is passed to an image build or an unrelated service.

## Bootstrap and reuse

```sh
bun run ops --directory="$ops_dir" prepare
bun run ops --directory="$ops_dir" status user
bun run ops --directory="$ops_dir" migrate user
bun run ops --directory="$ops_dir" migrate wallet
bun run ops --directory="$ops_dir" start
bun run ops --directory="$ops_dir" probe user
bun run ops --directory="$ops_dir" probe wallet
```

Prepare starts only required PostgreSQL/RabbitMQ services, creates the owning
database and non-superuser owner/runtime identities, grants connection permission,
and verifies supplied credentials. Repeat `prepare` to verify reuse: it never
generates or rotates passwords, migrates, seeds or deletes data. Changing a secret
file against retained database/broker credentials fails; perform intentional
credential rotation separately. Preserve the original `deployment.json` as the
bootstrap selection; `state.json` records the currently selected images after updates.
Direct inventory edits are unsupported.

Both migration and server use the same application's exact image. Only migration
receives the owner password. The owner can create owned schema objects; runtime
roles get the grants in the application's migrations. Unknown application
ownership and runtime migration usernames fail. `node-pg-migrate` retains its
advisory lock, ordering checks and single-transaction behavior. `start` refuses
pending migrations and never executes them. Startup verifies HTTP readiness and
reports messaging readiness separately, so broker outages do not prevent HTTP
startup. Updates require full readiness before reporting verification. Server startup and additional
application replicas cannot implicitly migrate.

Apps have private listeners; databases are on separate private per-application
networks. Only Kong publishes a host port, accepting HTTPS. Plain HTTP, application
listeners, operational health, PostgreSQL, broker management and Kong Admin are
not public entry points. Kong routes using HTTP readiness, keeping healthy HTTP
operations available during broker outages. Container liveness checks do not
restart unhealthy processes. Shutdown allows 20 seconds for the application's
existing 15-second drain contract.

```sh
bun run ops --directory="$ops_dir" stop user
bun run ops --directory="$ops_dir" start user
bun run ops --directory="$ops_dir" down
# Reuse the same directory and retained volumes:
bun run ops --directory="$ops_dir" prepare
bun run ops --directory="$ops_dir" start
```

## Interrupted operations and stale locks

`SIGINT`, `SIGTERM` and SSH-session hangup (`SIGHUP`) cancel the active command,
attempt cleanup of owned one-shot containers, release `.operation-lock`, and
return 130, 143 and 129 respectively. Database and broker volumes remain intact.
Check the command and cleanup results under `logs/` before retrying.

`SIGKILL`, host failure or reboot cannot run cleanup and may leave a stale lock.
Before removing it, confirm that no operator process for this directory remains,
including processes in other SSH sessions. Inspect this installation's containers:

```sh
project=$(bun --no-env-file -e 'console.log((await Bun.file(process.argv[1]).json()).project)' "$ops_dir/state.json")
docker ps -a --filter "label=com.docker.compose.project=$project" --format '{{.ID}} {{.Names}} {{.Status}}'
```

An interrupted migration may leave a running `<project>-command-*` container.
Verify its `dev.starter.owner` label against `state.json` and stop/remove only that
owned one-shot container before proceeding. Inspect the last operation's logs and
database migration status; a disconnected operator does not prove its migration
stopped. Once there is no active operator or one-shot command, remove the empty
lock directory and use `status` to assess the retained migration history:

```sh
rmdir "$ops_dir/.operation-lock"
bun run ops --directory="$ops_dir" status user
```

If preparation failed before `state.json` was created, use the process and log
checks; no managed Compose service has been started yet. Never remove a live
operator's lock to bypass concurrency protection.

## Update one application

Select a candidate without rebuilding or promoting siblings:

```sh
candidate='ghcr.io/your-organization/user@sha256:<candidate digest>'
bun run ops --directory="$ops_dir" update user --image="$candidate"
```

The command writes `transition-<id>.json` with the previous and candidate digests,
checks candidate migration status, stops the selected application, creates an owned
backup under `backups/`, runs applicable migrations, selects the candidate, starts
it and verifies private readiness. Gateway reload briefly interrupts ingress.
Sibling application containers and images are preserved. Nonpersistent images skip
database steps. Changed capabilities/routes require a separately planned resource
transition; this bounded updater rejects them instead of silently discarding state.

A failed migration exits nonzero, records a failed transition and leaves the prior
image selected with its server stopped. It never promotes the candidate or runs
migration down. Inspect the transition, `status` and owned database before deciding
whether to restart the prior image or retry a corrected candidate. If migration
succeeds but startup fails, state records the attempted candidate, the transition
still fails, and the previous digest remains available in that record. Do not
interpret an image pull or a migration success as a verified update.

## Compatible image rollback

First inspect current migration status and review both versions' reads/writes,
current schema, producer envelopes, consumers, pending outbox rows and retained
failure messages. An added unused table may permit the old image; a removed column
or retired event version may not. In the incompatible case, stop and plan a forward
fix or explicit data/contract recovery. Do not promise automatic schema reversal
or zero-downtime rollback.

Create a review JSON file containing the exact current image, target prior digest,
ordered applied migration names and substantive review explanations:

```json
{
  "application": "user",
  "currentImage": "<exact currently selected image>",
  "targetImage": "<exact prior image from transition record>",
  "migrationHistory": ["<applied migration name without .sql, in order>"],
  "schemaReview": "Explain why prior readers and writers work against the CURRENT schema.",
  "eventContractReview": "Explain compatibility with deployed peers and pending/retained envelopes."
}
```

```sh
bun run ops --directory="$ops_dir" status user
bun run ops --directory="$ops_dir" rollback user --image="$previous" --compatibility="$ops_dir/compatibility.json"
```

Set `previous` to the recorded prior digest. The command binds this review to both
images and the live migration history, takes a backup, changes only the image and
verifies readiness. It does not run migrations in either direction. A `missing file`
line in the old image's status means the current database contains a migration
unknown to that artifact; the schema review must evaluate it. The review is an
operator decision, not an automatic proof inferred from matching migration names.

## Private diagnosis and replay

```sh
bun run ops --directory="$ops_dir" probe user
bun run ops --directory="$ops_dir" probe wallet
bun run ops --directory="$ops_dir" inspect wallet --limit=100 --offset=0
bun run ops --directory="$ops_dir" replay wallet --message="$receipt" --limit=100 --offset=0
```

Use the receipt returned by inspection and the same scan window. User supports the
same commands for `user.create`. Messaging alone does not opt an application into
recovery: the image must own `app/messaging/failures.ts` with its application's
replay validator, matching the existing local recovery contract. Generated
applications without that interface are refused before broker access; their
retained messages remain untouched. These run the selected artifact's existing recovery
interface against its scoped broker. Inspection retains deliveries; replay preserves
bytes, event/command identity, correlation and properties and only acknowledges the
retained copy after confirmed mandatory publication. Unsupported payloads stay
retained; a broker acknowledgement never claims application completion. See
[failure queues](failure-queues.md) for reply-queue prerequisites and retry semantics.

`probe` reports readiness and backlog independently. Database/broker loss remains
visible as `not_ready` or `unavailable`, never a fabricated zero backlog. Wallet's
non-outbox backlog is `not_applicable`; inspect broker queues separately. To inspect
private queues and correlated logs, read the project name from `state.json`:

```sh
project=$(bun --no-env-file -e 'console.log((await Bun.file(process.argv[1]).json()).project)' "$ops_dir/state.json")
docker compose -p "$project" -f "$ops_dir/compose.json" exec -T rabbitmq rabbitmqctl list_queues -p "$project" name messages_ready messages_unacknowledged consumers
docker compose -p "$project" -f "$ops_dir/compose.json" logs --since=10m app-user app-wallet
```

Correlate request/correlation ID, event ID and User ID across pending publication,
retention, replay and Wallet consumption. Preserve unknown/unavailable results when
diagnostic commands fail. Each operator invocation retains command statuses and
output under `logs/<id>/` in the installation directory. Failures print the private
`run.log` path before disposable containers disappear; `result.json` preserves
command, interruption and cleanup statuses. Supplied secret values and credential
URLs are redacted. Logs and backups can still contain application data; protect them.

## Manual per-application backup and restore

```sh
bun run ops --directory="$ops_dir" backup user --output="$ops_dir/manual-user.dump"
bun run ops --directory="$ops_dir" backup wallet --output="$ops_dir/manual-wallet.dump"
```

Each custom-format archive includes that database's schema, application data,
migration history and grants. The adjacent `.json` records application, installation,
image, creation time and SHA-256. Copy both files to protected storage and verify
restoration regularly. Existing destinations are refused. Credentials/roles remain
in separately retained operator files and PostgreSQL identity preparation.

**RabbitMQ messages are excluded.** A PostgreSQL backup is not an atomic snapshot
of User, Wallet and RabbitMQ. User restore can republish already delivered events;
Wallet restore can remove deduplication evidence or accepted work. Before resuming,
evaluate pending outbox rows, published markers, retained failures, queued and
unacknowledged deliveries, and independently restored peer state. Never purge the
broker to make a database restore appear consistent.

Stop every application before restoring either database. The command also stops
Kong and verifies archive identity/checksum. It decodes the archive with `pg_restore`
before changing the database, then runs `DROP OWNED BY CURRENT_USER` and the restore
SQL through `psql --single-transaction` with `ON_ERROR_STOP`. This removes objects
introduced by later migrations, including dependent foreign keys, and restores the
backup's data, migration history and grants together. A decode or SQL failure
preserves the pre-restore database; the recovery gate remains unresolved. Temporary
archive and SQL files are removed during cleanup. The owner role and database are
retained; database identities and connection grants remain provisioned separately.
Restore is scoped to the same installation and owning database; cross-installation recovery requires
a separately reviewed procedure. See [pg_restore](https://www.postgresql.org/docs/18/app-pgrestore.html).

```sh
bun run ops --directory="$ops_dir" stop
bun run ops --directory="$ops_dir" restore user --input="$ops_dir/manual-user.dump"
# Compare owned data while applications are stopped, and inspect retained queues:
docker compose -p "$project" -f "$ops_dir/compose.json" exec -T postgres-user psql -U postgres -d user -c 'TABLE users'
bun run ops --directory="$ops_dir" inspect wallet
```

Compare IDs, counts and relevant columns with the backup's recorded application
data. Record the result and messaging decision in an assessment file, using the
IDs for **all** pending applications in `recovery.json` (`applications.<app>.id`):

```json
{
  "recoveryIds": ["<each pending id from recovery.json>"],
  "dataComparison": "Record the actual before/after comparison for each restored application.",
  "messagingReview": "Record pending/retained/peer-state assessment and the chosen recovery action; no broker purge."
}
```

```sh
bun run ops --directory="$ops_dir" start --assessment="$ops_dir/assessment.json"
bun run ops --directory="$ops_dir" probe user
```

Startup is blocked until every pending restore has completed and the assessment
lists exactly all current recovery IDs. Restoring a second application preserves
the first application's gate. A failed restore leaves that application unresolved;
retry its verified archive and assess the new ID before resuming. Recheck
HTTPS application data after startup. A successful command does not prove that
all distributed work completed.

## Verification and delivery evidence

```sh
bun run nx run test-runner:test-operations --skip-nx-cache
bun run check:full
```

The operational regression executes these commands with real Docker, a disposable
loopback-only registry, exact digests, supplied test certificates, PostgreSQL,
RabbitMQ and Kong. It covers bootstrap/reuse, private secrets and listeners,
owner/runtime separation, update failure, compatible rollback, both application
backups/restores, correlated replay and unavailable backlog. It retains owned
volumes and inventory under `.context/test-runs/operations-<id>/`; command logs
and results are included in the existing CI diagnostics collection. Use `down` on that exact
directory for cleanup. No command deletes volumes. Local-registry fixtures are
verification infrastructure, not a GHCR release or production deployment.

Report local checks, remote CI, registry publication and actual deployment as
separate states. This reference and its tests establish executable procedures;
they do not establish production operation or certificate renewal.

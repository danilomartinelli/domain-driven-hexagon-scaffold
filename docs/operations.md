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
and name determine its Compose project at bootstrap; a random owner label fences its
containers, networks and volumes. Commands refuse foreign ownership and concurrent
operators. `down` never deletes volumes. Retain the directory and backups securely
outside Git.

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

`deployment.json` remains the
[desired selection](#desired-applied-and-retained-state) for the installation's
lifetime. There is no default tag. Preparation reads `application.json` from each
selected image and verifies its application name. Persistence adds one private
database and an owner-only migration command; messaging adds a shared private
broker; exposure adds Kong with the image's explicitly declared routes. An
all-disabled application needs no secrets, certificates, database identities or
migrations, and retains private operational HTTP. Omit `https` when no image
enables exposure.

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

Selected images must carry the [application compatibility contract](application-compatibility.md).
The operator runs their packaged preflight without network or secrets before
provisioning and before any candidate update changes the installation. An
incompatible functionality group identifies its missing capability and leaves
services, credentials and durable work unchanged. Images predating this contract
must be rebuilt with their author-owned registrations.

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
and verifies supplied credentials. A [reviewed plan](#apply-a-reviewed-plan) can
instead bootstrap the selection, including migrations and verified startup.
Repeat `prepare` to verify reuse: it never generates or rotates passwords,
migrates, seeds or deletes data. Changing a secret
file against retained database/broker credentials fails; perform intentional
credential rotation separately. Repeated preparation operates the applied
installation and reports a differing desired selection without applying it. Direct
`state.json` edits are unsupported.

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

## Desired, applied and retained state

`deployment.json` holds the desired applications, exact image digests and HTTPS
ingress. Editing it changes only that request. `state.json` separately records:

- **Applied state:** the images and capabilities the managed Compose project
  operates. Each application keeps its last migration outcome (`committed`,
  `restored`, `failed` or `interrupted`, with the image and operation) and its
  last startup verification (`verified`, `failed` or `interrupted`, with `http` or
  `full` readiness). A selected digest or committed migration is not a verified
  startup.
- **Retained resources:** each persistent application's database volume, database,
  owner/runtime roles and credential files, and the broker volume, vhost and
  credential file. They are recorded when first applied and never removed by
  these commands.
- **Pending deployment:** the incomplete [topology deployment](#partial-outcomes-and-continuation),
  if any.

`status`, `probe`, `inspect`, `replay`, `backup`, `restore`, `migrate`, `start`,
`stop`, `retained` and `down` use the applied inventory even when the desired
selection adds or removes applications or is invalid. Ownership checks still
refuse resources labelled for another installation. The installation name is part of its recorded
identity; planning and image updates refuse a renamed `deployment.json`.

`update` and `rollback` record their candidate in `deployment.json` before changing
the installation and keep other desired edits. They refuse an invalid selection or
one without that application, and they reject changed capabilities or routes.
Only [`apply`](#apply-a-reviewed-plan) adds, removes or reconfigures applications
to match a reviewed desired selection; `prepare`, `start` and the other commands
never do.

Inventories with `"version": 1` are adopted by the next command other than `plan`.
Adoption keeps the project, owner label, credentials, volumes, applied images and
`deployment.json`. Outcomes before adoption are `unrecorded`. Such a
`deployment.json` still holds the bootstrap selection, so `plan` reports any image
updated since bootstrap as a requested change back to its bootstrap digest; select
the applied digest in `deployment.json` to keep it.

### Plan desired changes

```sh
bun run ops --directory="$ops_dir" plan
```

Planning verifies ownership, then inspects every desired image with the isolated
compatibility preflight and lists its packaged migrations. It reads migration
history only from running owned databases. The JSON preview contains:

| Field           | Content                                                                                 |
| --------------- | --------------------------------------------------------------------------------------- |
| `applied`       | Current images, capabilities and recorded migration/startup outcomes                    |
| `desired`       | The complete desired selection                                                          |
| `changes`       | Requested additions, removals, image, capability/route and ingress changes              |
| `services`      | Long-running services to add, stop, recreate or leave unchanged                         |
| `resources`     | Retained resources active/inactive before and after, new identities and missing secrets |
| `migrations`    | Applicable owned migrations; `unavailable` when the database is not running             |
| `interruptions` | Expected maintenance effects, including application restarts and gateway reloads        |

An unreadable history is never reported as empty. A rejected selection exits
nonzero and explains each application: incompatible composition, an image declaring
another application, an unavailable image or exposure without HTTPS. Planning does
not start, stop or recreate services, migrate, change credentials, queues,
`state.json` or `deployment.json`; it writes diagnostics under `logs/` and holds the
operation lock while it runs.

### Apply a reviewed plan

Save the preview, review it, then apply exactly that file:

```sh
bun run ops --directory="$ops_dir" plan > "$ops_dir/plan.json"
bun run ops --directory="$ops_dir" apply --plan="$ops_dir/plan.json"
```

`apply` plans again and refuses, before changing inventory or services, when the
reviewed installation, applications, images, capabilities, routes, ingress,
services, retained resources or interruptions no longer match; plan again after
any edit. Recorded outcomes and live migration history may differ from the review.
It also refuses missing or invalid secret files, an unassessed restore, and a
promotion of an application whose candidate verification is pending. An image
whose database already applied migrations unknown to it is refused: during review
when the history is readable, otherwise after starting the database and before
its server stops. Return to an older image only through
[compatibility-reviewed rollback](#compatible-image-rollback), which applies to an
applied application without capability changes. To reactivate an application or
change its capabilities, first apply an image that contains its database's
migrations, then roll back with a review. A directory without
`state.json` is bootstrapped this way: the inventory is recorded before any
resource exists. The operation writes `apply-<id>.json` with the baseline and
desired selections, each step's images, status and transition records, and every
apply or continue attempt with its diagnostic log. It runs these steps in order:

1. **Ingress:** select a changed HTTPS listener.
2. **Removals:** stop and remove each removed application's server and database
   containers. Its volume, roles, credential files and queued messages remain.
3. **Promotions,** one per added or changed application in name order: start
   newly required PostgreSQL/RabbitMQ, create absent identities and verify the
   supplied credentials, check migration status, stop the prior server, back up an
   existing database and run the owned migrations with the owner secret. The image
   is then selected and verified as an
   [update candidate](#candidate-verification-and-explicit-continuation). Servers
   receive runtime secrets only and never migrate.
4. **Reconciliation:** stop and remove infrastructure that the applied selection
   no longer needs, such as the database of an application whose persistence was
   disabled, an unused broker or gateway, then reload Kong after route changes.

Applications the plan leaves unchanged keep their containers, images, credentials
and data. Disabling a capability or removing an application never deletes a
database, volume, credential or queued message. Producers keep publishing durable
work for an inactive consumer; its absence never purges or cancels queues.
Reactivation reuses the retained volume, database, roles and credential files, and
the consumer recovers queued work with its original event identity. A retained
credential file changed while inactive fails provisioning instead of rotating it.
Inspect retained resources at any time, including after removal or `down`:

```sh
bun run ops --directory="$ops_dir" retained
```

The JSON lists each retained database and the broker with its applied activity,
Docker container state (such as `running` or `exited`, or `absent`) and volume
presence. `down` stops and removes every owned container, including retired
services left by an interrupted operation, and keeps all volumes.

### Partial outcomes and continuation

A failed step stops every later step. The command exits nonzero and prints each
step's status. Completed steps stay applied with their resources; the failed
application keeps its step's safe state:

| Failure                                     | Application state                                                           | Step status            |
| ------------------------------------------- | --------------------------------------------------------------------------- | ---------------------- |
| Provisioning or migration                   | Prior image, if any, stays applied; stopped once its migration window began | `failed`               |
| Candidate HTTP ready, messaging unavailable | Candidate serving HTTP with verification pending                            | `verification-pending` |
| Candidate process or HTTP failed            | Candidate stopped; migrated state retained                                  | `verification-failed`  |
| Signal                                      | As at the interruption; owned one-shot containers removed                   | `interrupted`          |

A failed migration rolls back in its single transaction. A database or broker
started for a failed promotion keeps running, reported by `retained`, until a
later deployment uses or retires it or `down` stops it. No failure restores
previous images, runs migration down, purges broker state or retires
infrastructure. `state.json` keeps `pendingDeployment` until the deployment
completes, and `update` is refused meanwhile. Repair the cause, then continue from
the recorded progress with the same desired selection:

```sh
bun run ops --directory="$ops_dir" continue
```

Continuation skips completed steps without repeating their migrations or backups.
It verifies a pending candidate again, as `continue <app>` does, and retries a
failed promotion from provisioning; only migrations absent from the database's
history run. Supply `--assessment=<file>` after a restore. To change course
instead, edit `deployment.json`, then plan and apply the new selection. That
deployment supersedes the incomplete one, whose record remains. Removing a pending
candidate's application withdraws its transition; changing its image still
requires `continue <app>` or compatibility-reviewed rollback first. A completed
deployment lists applied applications whose servers are not running, such as a
prior image stopped by a failed migration; it never restarts them. Inspect
`status` and start them explicitly.

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

Before changing the Desired selection, update reads the live migration history
and the Candidate's packaged migrations. It refuses migrations unknown to the
Candidate, names them and directs the operator to
[compatibility-reviewed rollback](#compatible-image-rollback). This refusal
writes no Transition, leaves `deployment.json` unchanged and keeps the server
running. If history is unavailable during preflight, a second check still refuses
an older image before stopping the server.

The command then selects the Candidate in `deployment.json`, writes
`transition-<id>.json` with the previous and candidate digests, checks candidate
migration status, stops the selected application, creates an owned backup under
`backups/`, runs applicable migrations, selects the candidate, starts it and
verifies private readiness. Gateway reload briefly interrupts ingress. Sibling
application containers and images are preserved. Nonpersistent images skip database
steps. Changed capabilities/routes appear in `plan`; this bounded updater rejects
them instead of silently discarding state. Apply them through a
[reviewed plan](#apply-a-reviewed-plan).

A signal records `interrupted` in the Transition and, for topology Promotions,
in its deployment step. An interruption before verification marks unfinished
migration work as `interrupted` in the Transition and Applied state only when
persistence is enabled. Nonpersistent Candidates retain `not-applicable` without
adding migration evidence to the Applied state. Completed migrations remain
committed during interrupted verification, and Continuation does not repeat them.

A failed migration exits nonzero, records a failed transition and migration outcome
and leaves the prior image applied with its server stopped. It never promotes the
candidate or runs migration down. `deployment.json` keeps the requested candidate,
so `plan` reports the outstanding image change; restore the applied digest there to
withdraw it. Inspect the transition, `status` and owned database before deciding
whether to restart the prior image or retry a corrected candidate.

### Candidate verification and explicit continuation

Image selection, migration completion, observed runtime and transition verification
are separate evidence in `transition-<id>.json`. `state.json` retains each application's
pending transition until its verification succeeds. A selected digest, completed migration or
live process alone does not establish a completed update.

The applied application's startup outcome also remains `pending` during incomplete
verification, becomes `failed` for confirmed process/HTTP failure, and changes to
`verified` only when verification succeeds. `plan` reports these outcomes separately
from committed migrations, including after explicit continuation.

| Verification result                                       | Candidate behavior                                                          | Transition evidence                                      |
| --------------------------------------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------- |
| HTTP and applicable messaging roles ready                 | Keep serving; complete verification                                         | `verified`                                               |
| HTTP ready, messaging unavailable                         | Keep serving usable HTTP through Kong; allow application transport recovery | `verification-pending`, `messaging-degraded`             |
| Process running, HTTP probe unavailable                   | Keep the candidate running; readiness remains unknown                       | `verification-pending`, `http-unknown`                   |
| Process or HTTP unavailable after the verification window | Stop only the candidate, preserving its selected image and durable state    | `verification-failed`, `process-failed` or `http-failed` |

Candidate verification polls for up to 60 seconds, with bounded Docker and HTTP
probes. A failed Docker probe is unknown readiness, so it leaves verification
pending without stopping the running candidate or reporting success. Confirmed
process/HTTP failure uses the application's existing 15-second
shutdown contract and Compose's longer 20-second grace. The updater retains the
database, broker resources, backup, container and private diagnostic records.
These rules apply to candidates; ordinary running applications retain their
database/broker outage recovery behavior.

All incomplete results exit nonzero and block another promotion of that
application. Independent application operations remain available and preserve the
pending transition. Inspect `probe`, `status`, the transition and its diagnostic log,
then repair the failed dependency or runtime prerequisite and explicitly continue:

```sh
bun run ops --directory="$ops_dir" probe user
bun run ops --directory="$ops_dir" status user
bun run ops --directory="$ops_dir" continue user
```

Continuation starts a stopped candidate or verifies the already running one. It
does not invoke completed migrations, create another backup or replace sibling
applications. Automatic messaging recovery does not clear pending verification;
only successful explicit continuation does. Each attempt retains its observation
and diagnostic reference in the transition. `probe` also reports a stopped or
missing process without claiming HTTP readiness.

If a database was restored, continuation enforces the same global recovery
assessment as startup. Supply `--assessment=<file>` after every pending restore
has completed and its data/messaging assessment covers all recovery IDs; see
[backup and restore](#manual-per-application-backup-and-restore). Successful
continuation clears that assessed recovery barrier.

Alternatively, use compatibility-reviewed image rollback below for the pending
application. No failure automatically restores previous images, runs migration
down, purges broker state or rolls back the distributed installation atomically.
Do not edit the pending transition or inventory to bypass recovery.

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

Promotion decisions run in process through a semantic installation runtime.
The [fast promotion suite](../scripts/tests/operations-promotion.test.ts) uses
independent runtime effects, real temporary records and a manual verification
clock. The [readiness suite](../scripts/tests/operations-readiness.test.ts)
characterizes Docker response interpretation. Both run in `test-runner:test`,
`test:unit`, the light gate and CI quality checks. The polling window still starts
after startup and gateway refresh, checks readiness before expiration, and can
accept an observation that finishes after 60 seconds; durable timestamps use real
time.

The [command suite](../scripts/tests/operations.test.ts) retains argument,
preflight, rollback review, desired-selection and deployment-linkage coverage,
plus real process signals, exit codes, locks and subprocess cleanup. These and
the live Docker cases below continue to run through `test:operations`; in-memory
runtime tests do not establish those integration contracts.

```sh
bun run nx run test-runner:test-operations --skip-nx-cache
bun run check:full
```

The operational regression executes these commands with real Docker, a disposable
loopback-only registry, exact digests, supplied test certificates, PostgreSQL,
RabbitMQ and Kong. It covers bootstrap/reuse, private secrets and listeners,
owner/runtime separation, migration failure, candidate messaging degradation,
process/HTTP verification failure and continuation, compatible rollback, both application
backups/restores, correlated replay and unavailable backlog. Planning coverage
adopts a version 1 inventory, edits the desired selection, previews it, rejects
incompatible, misidentified and invalid selections, inspects and shuts down the
applied installation, refuses a foreign owner, restarts with stable identities and
data and preserves a sibling installation. Topology coverage bootstraps User
through plan and apply, adds Wallet without touching User, withdraws Wallet's
exposure, then removes Wallet while User keeps queuing its events. It inspects
retained resources, refuses a foreign owner and shuts down. Reactivation on an
image older than Wallet's retained database is refused; a compatible image
supersedes it with the same roles, volumes and credentials, recovering the queued
event identity.
Disabling both applications' exposure retires Kong. A two-application apply stops
after a later migration failure, an earlier candidate failure and an earlier
candidate's messaging degradation; explicit continuation completes each without
repeating migrations. It also refuses an older image without a compatibility
review, and supersedes an interrupted deployment without restarting its stopped
server. It retains owned
volumes and inventory under `.context/test-runs/operations-<id>/`; command logs
and results remain there as local full-gate evidence. Use `down` on that exact
directory for cleanup. No command deletes volumes. Local-registry fixtures are
verification infrastructure, not a GHCR release or production deployment.

Report local checks, remote CI, registry publication and actual deployment as
separate states. This reference and its tests establish executable procedures;
they do not establish production operation or certificate renewal.

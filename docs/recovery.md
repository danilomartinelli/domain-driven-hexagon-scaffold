# Distributed registration and recovery

User success means its profile and pending integration event committed. Wallet
creation follows asynchronously. A broker confirmation means the message was
accepted; inspect Wallet's REST or GraphQL lookup for processing completion.
A missing Wallet yields REST 404 and GraphQL `null` while delivery is pending.

## Independent operational signals

Probe each application's own listener (`USER_HTTP_PORT` or `WALLET_HTTP_PORT`),
not the Kong proxy. These endpoints return only status, counters and timestamps;
they expose no credentials, message bodies or profile data.

| Endpoint                  | Meaning and HTTP status                                                                                                                                                                              |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/health/live`            | 200 while the process serves HTTP; never queries a dependency                                                                                                                                        |
| `/health/ready/http`      | 200 when the owning database is queryable; 503 otherwise                                                                                                                                             |
| `/health/ready/consumer`  | 200 when the subscription is active and its database is queryable; 503 otherwise                                                                                                                     |
| `/health/ready/publisher` | User: 200 when its publishing session and database are available, 503 otherwise. Wallet: 200 with `status: "not_applicable"`                                                                         |
| `/health/ready`           | Separate `http`, `consumer`, `publisher` states; 503 if any applicable component is not ready                                                                                                        |
| `/health/backlog`         | User: 200 with `pendingCount` and `oldestAgeSeconds`; zero pending has null age. Database failure: 503 with `status: "unavailable"`, never a false zero. Wallet: 200 with `status: "not_applicable"` |

Use `/health/ready/http` to decide whether to send REST/GraphQL traffic. The
aggregate probe deliberately reports messaging degradation even when HTTP is
usable. Probes do not initiate broker connections or change worker retries.
Database readiness and backlog reads each coalesce concurrent requests and cache
results for one second. A probe responds within five seconds even if the database
connection stalls; the outstanding query is reused until it settles, so repeated
probes cannot accumulate database work. Observe recovery with a bounded polling deadline, not a
busy loop. A database outage after startup leaves liveness available. Initial
application startup still requires its own database, and never waits for RabbitMQ.

```sh
bun run env:exec --environment=development --run=default -- sh -c 'for port in "$USER_HTTP_PORT" "$WALLET_HTTP_PORT"; do for path in live ready/http ready/consumer ready/publisher ready backlog; do curl -sS --max-time 20 -w "\nHTTP %{http_code}\n" "http://127.0.0.1:$port/health/$path"; done; done'
```

Consumer and User publisher states include `connected`, `failures`, `retries`,
`retryDelayMs` and `lastFailureAt`. Counters describe failed/retried worker
sessions **in this process**, not per-message delivery attempts. They reset on
restart; the database backlog and RabbitMQ queues persist. `retryDelayMs` is the
scheduled backoff, not a countdown. Database loss makes messaging readiness
`not_ready` even if its AMQP connection is still present. Readiness does not
guarantee every payload will succeed or mean a failure queue is empty.

## Correlated logs

Both applications emit one JSON object per log line. Operational records carry
`service`, `operation` and, where a message exists, `eventId`/`correlationId` or
`commandId`. REST accepts a valid body `requestId` as correlation; GraphQL gets
request context automatically. RabbitMQ `user.create` preserves the command's
correlation independently of HTTP. Successful creation logs the allocated event
identity after the profile/outbox transaction commits.

```text
user.create.committed (User; command/request -> eventId, correlationId)
  outbox.confirmed   (User; broker routed and confirmed that event)
  outbox.published   (User; publication completion committed in its database)
  wallet.event.committed (Wallet; local transaction committed, including duplicates)
```

Wallet may commit before User records publication completion. Failed publication
logs `outbox.failed` with the current event identity when one was selected, plus
the retry delay. Consumer failures and retained invalid messages carry their
transport identity where available. No message body is added to these records.
Capture each application's console output and filter JSON records locally; for
example, after saving User output to `.context/user-incident.log`:

```sh
jq -R 'fromjson? | select(.correlationId == "incident-42") | {service, operation, eventId, commandId, correlationId}' .context/user-incident.log
```

Keep both event and correlation identities. A correlation can cover several
events, and at-least-once delivery can produce repeated records for one event.

## Queue diagnostics

RabbitMQ's local CLI reports ready/unacknowledged counts, active consumers and
queue state without reading payloads. After preparing the selected environment:

```sh
project=$(bun --no-env-file -e 'import { readEnvironment } from "./database/environment"; console.log(readEnvironment("development", "default").project)')
bun run env:exec --environment=development --run=default -- sh -c 'docker compose --project-name "$1" --file ".context/test-runs/$1/compose.json" exec -T rabbitmq rabbitmqctl -q list_queues -p "$RABBITMQ_VHOST" name messages_ready messages_unacknowledged consumers state --formatter=json' sh "$project"
```

Inspect `user.create`, `wallet.user-created` and their `.failed` queues. A running
consumer normally has a positive consumer count; retained failure queues have
zero consumers and keep messages until explicit operator action. During broker
loss this command fails instead of reporting empty queues. The existing
[failure inspection commands](failure-queues.md#select-and-inspect) provide
message identity and validation reasons without payloads by default. Failed
messages do not automatically drain with infrastructure recovery; inspect and
explicitly replay only eligible messages.

## Run and observe

Prepare and migrate both databases, then start both applications from the root:

```sh
bun run env:prepare --environment=development --run=default
for app in user wallet; do
  DATABASE_APP="$app" bun run env:exec --environment=development --run=default -- bun run migration:up
done
bun run env:exec --environment=development --run=default -- bun run start
```

In another terminal, create a profile. Keep the returned `id`:

```sh
bun run env:exec --environment=development --run=default -- sh -c 'curl -fsS "http://127.0.0.1:$USER_HTTP_PORT/v1/users" -H "Content-Type: application/json" -d "{\"email\":\"recovery@example.com\",\"country\":\"England\",\"street\":\"Baker street\",\"postalCode\":\"NW16XE\"}"'
```

Replace `USER_ID` below with that ID. Repeat the lookup with a bounded deadline
(for example 30 seconds) rather than treating a registration response as proof
of Wallet completion:

```sh
bun run env:exec --environment=development --run=default -- sh -c 'curl -sS "http://127.0.0.1:$WALLET_HTTP_PORT/v1/wallets/by-user/USER_ID"'
bun run env:exec --environment=development --run=default -- sh -c 'curl -sS "http://127.0.0.1:$WALLET_HTTP_PORT/graphql" -H "Content-Type: application/json" -d "{\"query\":\"{ walletByUser(userId: \\\"USER_ID\\\") { id userId balance } }\"}"'
```

Both return the same Wallet with balance zero. To observe a stopped Wallet,
start `start:user` and `start:wallet` in separate terminals instead of `start`.
Stop Wallet, create another profile with a new email, then restart Wallet. User
creation still succeeds and the queued event creates the Wallet afterward.

## Broker outage and restart

For the selected development run only, obtain the Compose project and stop its
broker. These commands preserve containers' volumes and other workspaces:

```sh
project=$(bun --no-env-file -e 'import { readEnvironment } from "./database/environment"; console.log(readEnvironment("development", "default").project)')
docker compose --project-name "$project" --file ".context/test-runs/$project/compose.json" stop rabbitmq
```

Restart User while RabbitMQ is stopped. Its HTTP and GraphQL APIs remain usable;
create a profile with a fresh email. The outbox persists through another User
restart. Deleting that profile before broker recovery also leaves the pending
event intact. Restore the broker:

During the outage, `/health/live` and `/health/ready/http` stay 200 on each
running service. Both consumers and User's publisher become 503; Wallet's
publisher remains explicitly not applicable. Poll User's `/health/backlog` once
per second: each committed creation increases pending count and the oldest age
grows. Capture the `user.create.committed` identities before restarting User.

```sh
docker compose --project-name "$project" --file ".context/test-runs/$project/compose.json" start rabbitmq
```

User retries automatically with exponential backoff capped at 10 seconds. Wallet
reconnects independently. No manual envelope reconstruction or new event identity
is needed. Within a bounded recovery window (for example 30 seconds), observe
messaging readiness return to 200, pending count fall to zero and age become
null. Match publication and Wallet commit logs to the saved event/correlation
identities. Also inspect queue ready/unacknowledged counts: a drained outbox means
broker acceptance, not necessarily Wallet completion. Observe the final Wallet
through both APIs. Stop the applications and
shut down only this environment when finished:

```sh
bun run env:down --environment=development --run=default
```

## Durable transitions and evidence

The [system suite](../tests/integration/user-wallet.test.ts) and
[publication component suite](../src/apps/user/tests/component/publication-recovery.test.ts)
exercise real PostgreSQL and RabbitMQ. The September 30, 2026 implementation
runs demonstrated these persisted and broker-visible outcomes:

| Forced condition                                | Evidence at the actual boundary                                                                                                                         |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| User transaction rolls back                     | No profile, no outbox row, no queued event                                                                                                              |
| Wallet process stopped                          | User response succeeds; `published_at` is set, but Wallet DB is empty until its process starts                                                          |
| Successful publication                          | Stored envelope equals broker body; `messageId` equals `event_id`; delivery mode is persistent (`2`)                                                    |
| Mandatory routing return                        | Broker queue stays empty; `published_at` remains null despite broker confirmation; reconnection redeclares routing                                      |
| Confirmation lost in transit                    | A TCP gate observes and withholds the real broker ACK; the publisher times out, leaves work pending and republishes the same bytes and ID after restart |
| Completion update fails after broker acceptance | The original message exists, the outbox remains pending, and retry delivers the same identity; Wallet retains one row and one deduplication record      |
| RabbitMQ stopped and User restarted             | REST and GraphQL creations persist; their original envelopes survive restart and broker recovery unchanged                                              |
| Profile deleted while pending                   | The profile is absent; its original valid event still creates a Wallet after recovery                                                                   |
| Wallet write fails                              | User remains committed; Wallet and its deduplication write both roll back, then recover together                                                        |

Wallet's [component tests](../src/apps/wallet/tests/component/user-created.test.ts)
also cover redelivery after a crash between database commit and consumer ACK,
concurrent deliveries and preservation of existing balances.

Run the evidence again with isolated owned infrastructure:

```sh
bun run test:e2e
bun run test:component
# Focused live operational incident verification (never cached):
bun run nx run e2e:test-operations
```

Each run prints its command and cleanup statuses and the path to its retained
`run.log`/`result.json` under `.context/test-runs`. System cleanup stops both
processes before purging queues and truncating their separate databases, so a
previous scenario cannot deliver work into the next one. See
[developer checks](developer-checks.md) for the final quality gate.

The [operational suite](../tests/integration/operations.test.ts) executes the
probes, broker stop/start with application restart, persistent backlog growth
and drain, correlated REST/GraphQL/command publication and consumption, and the
queue CLI above. It pauses each owned PostgreSQL container in turn (preserving the test tmpfs): only that
service becomes unready, its liveness stays available, the sibling API remains
usable, and readiness recovers after the database resumes. All resources are
isolated by the environment runner and restored before cleanup.

For retained invalid or unsupported commands/events, use the scoped
[inspection and replay workflow](failure-queues.md). Broker acceptance, local
application commit and downstream consumer completion remain separate states.

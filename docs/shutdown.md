# Shutdown and restart

Both applications handle `SIGTERM` and `SIGINT` with the same **15-second total
deadline**, measured from the first signal. Repeated signals do not start another
shutdown. In an OCI container Bun is PID 1; `docker stop --time=20` sends it SIGTERM
and gives its existing 15-second deadline time to finish. Development supervisors
stop their owned app containers on interruption; infrastructure remains ready.

```text
signal -> draining: refuse new business requests; cancel consumers; stop outbox claims
       -> await accepted HTTP requests, transactions, confirmations and ACKs
       -> close messaging channels, then broker connections
       -> stopping: close HTTP and database pools through Nest
       -> natural process exit, code 0
deadline/error -> exit 1; recover durable work on restart
```

Consumer cancellation starts immediately, before waiting for in-flight work.
Channel closure is ordered after buffered ACKs; closing only the connection can
overtake them. A delivery arriving after draining begins is left unacknowledged.
The publisher finishes only its current claim; a User commit during shutdown
can leave a new event pending for the next process.

A consumer's delivery deadline ends its broker session without acknowledgement;
the real handler remains in drain until it settles. Messaging readiness stays
unavailable and reconnection waits, so this instance cannot execute its
redelivery concurrently. Shutdown drains the same work before closing database
pools, bounded by the existing 15-second total deadline. If it expires, the
process exits 1 and the durable recovery below applies. See the
[shared consumer contract](rabbitmq.md#sessions-and-drain).

During draining, REST, GraphQL and other non-health requests receive HTTP 503
with `reason: "draining"` and `Connection: close`. Already accepted requests get
a bounded opportunity to finish. `/health/live` remains 200 while HTTP is open.
`/health/ready` includes `lifecycle: "running" | "draining" | "stopping"`; every
applicable readiness component becomes 503 immediately on shutdown, including
when a cached database probe was healthy. Wallet's publisher remains
`not_applicable`. Backlog probing stops issuing database work during shutdown;
User reports `unavailable`, never a false zero. Once HTTP closes, probes fail to
connect.

Normal shutdown closes owned HTTP, AMQP and database handles. Once the event loop
is empty, it records completion and calls `process.exit()`, because `bun --watch`
(`start:dev`) would otherwise keep the drained process alive.
The deadline also catches handles that remain open after Nest closes. Structured
records include `service`, `signal`, `deadlineMs` and these operations:

- `shutdown.started`: new work is refused.
- `shutdown.completed`: the event loop emptied after resource closure; includes
  `elapsedMs`. The process exits immediately afterwards.
- `shutdown.timed_out` or `shutdown.failed`: nonzero termination, without a
  completion record. These never imply that in-flight work succeeded.

Event logs retain their original `eventId` and `correlationId` through restart.
A missing confirmation logs `publisher.failed`; it cannot produce `outbox.published`.
Shutdown completion describes process cleanup, not an empty outbox or queue.

## Durable recovery

| Interrupted boundary                              | Recovery                                                                                                                         |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Before User transaction commit                    | Profile and outbox insert roll back together; retry the original request after inspecting its outcome.                           |
| After User commit, before publication completion  | Stored envelope remains pending. Restart publishes the same event identity; uncertain broker acceptance can produce a duplicate. |
| Before Wallet transaction commit                  | Wallet insertion and deduplication claim roll back; the unacknowledged delivery returns to the queue.                            |
| After Wallet commit, before broker ACK acceptance | Redelivery finds the durable event claim. It preserves the original Wallet and any nonzero balance.                              |

`SIGKILL` is an abrupt failure: it cannot drain or run shutdown hooks. A shutdown
deadline also forces process exit; the OS closes connections and PostgreSQL and
RabbitMQ recover their uncommitted/unacknowledged work. In both cases, inspect
durable state after restart. A client disconnected before receiving a response
cannot infer rollback: a successful commit may already have happened.

The existing [User command response and retry contract](user-commands.md) still
applies. Repeating a committed `user.create` command can return an email conflict;
it does not undo the original profile or pending event.

## Commands

With development prepared and migrated, run a service through its private
container supervisor. Ctrl-C stops that application while retaining infrastructure:

```sh
bun run env:exec --environment=development --run=default -- bun run start:user
```

For an explicit Docker stop, select the prepared environment's Compose file:

```sh
project=$(bun --no-env-file -e 'import { readEnvironment } from "./database/environment"; console.log(readEnvironment("development", "default").project)')
docker compose -p "$project" -f ".context/test-runs/$project/compose.json" stop --timeout 20 app-user
```

Restart the same foreground command to recover pending work. No migration, seed,
queue purge or outbox rewrite is required for a restart. Keep PostgreSQL and
RabbitMQ running; stopping a disposable tmpfs container destroys its data.

Use the [readiness/backlog probes and queue diagnostics](recovery.md) to observe
pending work draining and REST/GraphQL Wallet lookup to confirm the business
outcome. Keep PostgreSQL and RabbitMQ running while restarting applications;
stopping a disposable tmpfs container destroys its data.

## Executable evidence

The shutdown system tests start the real service entry points and use real
signals, PostgreSQL locks and a TCP gate in front of the owned RabbitMQ broker.
They distinguish graceful termination, missing confirmation, forced deadline
and `SIGKILL`. The gate can lose an outbound ACK after the real Wallet commit;
it does not replace the consumer or database transaction with a test worker.
Assertions cover drained requests and commands, pending publication, rollback,
commit-before-ACK redelivery, preserved balances, correlated logs, exit after an
empty event loop and closed database sessions. Polling is bounded; fixtures
release locks, restore paused services and close their owned sockets even after
failure.

```sh
bun scripts/with-test-database.ts -- bun test --preload ./tests/setup/preload.ts ./tests/integration/shutdown*.test.ts
bun run test:component
bun run check:full
```

The provisioned wrapper cleans up only its owned containers and network. Logs
and cleanup exit statuses remain under `.context/test-runs/`. The independent
component suites continue exercising each application's database and messaging
behavior without the sibling application running.

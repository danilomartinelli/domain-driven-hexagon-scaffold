# Shutdown and restart

Both applications handle `SIGTERM` and `SIGINT` with the same **15-second total
deadline**, measured from the first signal. Repeated signals do not start another
shutdown. Send the signal to the Bun application PID in its structured startup
logs, not an Nx or watch-mode supervisor. Allow the process at least 15 seconds
before a supervisor escalates to `SIGKILL`.

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

During draining, REST, GraphQL and other non-health requests receive HTTP 503
with `reason: "draining"` and `Connection: close`. Already accepted requests get
a bounded opportunity to finish. `/health/live` remains 200 while HTTP is open.
`/health/ready` includes `lifecycle: "running" | "draining" | "stopping"`; every
applicable readiness component becomes 503 immediately on shutdown, including
when a cached database probe was healthy. Wallet's publisher remains
`not_applicable`. Backlog probing stops issuing database work during shutdown;
User reports `unavailable`, never a false zero. Once HTTP closes, probes fail to
connect.

Normal shutdown closes owned HTTP, AMQP and database handles and exits naturally.
The deadline also catches handles that remain open after Nest closes. Structured
records include `service`, `signal`, `deadlineMs` and these operations:

- `shutdown.started`: new work is refused.
- `shutdown.completed`: natural exit after resource closure; includes `elapsedMs`.
- `shutdown.timed_out` or `shutdown.failed`: nonzero termination, without a
  completion record. These never imply that in-flight work succeeded.

Event logs retain their original `eventId` and `correlationId` through restart.
A missing confirmation logs `outbox.failed`; it cannot produce `outbox.published`.
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

With the development environment already prepared and migrated, run a service
directly so its logged PID is the application process:

```sh
bun run env:exec --environment=development --run=default -- bun src/apps/user/main.ts
# In another terminal, set APP_PID to that process's logged pid, then:
kill -TERM "$APP_PID"
# SIGINT uses the same drain path:
kill -INT "$APP_PID"
```

Restart with the same environment and database. No migration, seed, queue purge
or outbox rewrite is necessary just to recover interrupted work:

```sh
bun run env:exec --environment=development --run=default -- bun src/apps/user/main.ts
# Run independently in another terminal, or restart Wallet alone:
bun run env:exec --environment=development --run=default -- bun src/apps/wallet/main.ts
```

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
commit-before-ACK redelivery, preserved balances, correlated logs, natural exit
and closed database sessions. Polling is bounded; fixtures release locks, restore
paused services and close their owned sockets even after failure.

```sh
bun scripts/with-test-database.ts -- bun test --preload ./tests/setup/preload.ts ./tests/integration/shutdown*.test.ts
bun run test:component
bun run check:full
```

The provisioned wrapper cleans up only its owned containers and network. Logs
and cleanup exit statuses remain under `.context/test-runs/`. The independent
component suites continue exercising each application's database and messaging
behavior without the sibling application running.

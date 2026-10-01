# Distributed registration and recovery

User success means its profile and pending integration event committed. Wallet
creation follows asynchronously. A broker confirmation means the message was
accepted; inspect Wallet's REST or GraphQL lookup for processing completion.
A missing Wallet yields REST 404 and GraphQL `null` while delivery is pending.

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

```sh
docker compose --project-name "$project" --file ".context/test-runs/$project/compose.json" start rabbitmq
```

User retries automatically with exponential backoff capped at 10 seconds. Wallet
reconnects independently. No manual envelope reconstruction or new event identity
is needed. Observe the final Wallet through both APIs. Stop the applications and
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
```

Each run prints its command and cleanup statuses and the path to its retained
`run.log`/`result.json` under `.context/test-runs`. System cleanup stops both
processes before purging queues and truncating their separate databases, so a
previous scenario cannot deliver work into the next one. See
[developer checks](developer-checks.md) for the final quality gate.

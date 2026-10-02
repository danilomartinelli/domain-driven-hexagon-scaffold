# Inspect and replay retained deliveries

Invalid payloads and unsupported versions are retained unchanged in durable
failure queues. They have no automatic consumer or expiration. Fix the producer
for new work; deploy a compatible consumer before replaying an older supported
contract. Replay never repairs a payload, rewrites a version, or assigns a new
message, command, event or correlation identity.

| Application | Meaning                            | Failure queue                | Replay destination    |
| ----------- | ---------------------------------- | ---------------------------- | --------------------- |
| User        | `user.create` command with a reply | `user.create.failed`         | `user.create`         |
| Wallet      | `user.created` integration event   | `wallet.user-created.failed` | `wallet.user-created` |

These are separate contracts. Replaying a User command may create a profile and
outbox event; replaying a Wallet event never invokes User creation. Replay sends
directly to the selected application's queue rather than broadcasting the event
again to other subscribers.

## Select and inspect

Run from the repository root after [preparing the environment](database.md#development).
Both `--environment` and `--run` are mandatory; select `development` or `test`
and the existing run. The command verifies the workspace manifest and Docker
owner labels before connecting. Conflicting `RABBITMQ_*` shell overrides are
rejected, including in development. Credentials come from the local manifest;
none belong in command arguments or examples.

```sh
bun run nx run user:failures-inspect --environment=development --run=default
bun run nx run wallet:failures-inspect --environment=development --run=default
```

The JSON record reports the failure queue's ready count and up to 20 messages:
`receipt`, original AMQP `messageId`/`correlationId` when present, current
contract eligibility, and a validation reason on rejection. Inspection borrows
messages with manual acknowledgement and requeues them on connection close;
it does not remove them. Unacknowledged work held by another operator is not
included in the ready count. Run one operator at a time for a stable view.

Use `--limit=100` for pages of up to 100 messages (1–1000 per page), and
`--offset=100` for the next page. The default offset is zero. Earlier ready
messages are held without acknowledgement while the page is read; closing the
connection requeues all skipped and inspected messages. Use the same offset and
limit for replay so it can reach the selected receipt. Paging does not discard
invalid work, even when it precedes eligible deliveries in a large backlog.
The overall operation deadline still applies: a timed-out scan retains all work.

```sh
bun run nx run wallet:failures-inspect --environment=development --run=default --offset=1000 --limit=100
```

To explicitly inspect the original bytes and all retained AMQP properties:

```sh
bun run nx run user:failures-inspect --environment=development --run=default --limit=100 --payload
bun run nx run wallet:failures-inspect --environment=development --run=default --limit=100 --payload
```

`contentBase64` preserves malformed JSON and invalid UTF-8 without conversion.
The properties include the original headers, failure reason and routing
metadata. User command payloads contain profile data; opt-in output and the
environment runner's local log must be treated as sensitive. Default inspection
and diagnostic errors do not print payloads or broker credentials.

## Explicit replay

Before replaying after a service update, check the destination's supported
versions and the [contract retirement gates](contract-evolution.md#coexistence-retirement-and-replay).
A newer local validator alone does not establish deployed consumer compatibility.

Copy the 64-character `receipt` from inspection. It fingerprints the retained
bytes and AMQP properties, not a mutable queue position or delivery tag.
Identical retained copies have the same receipt; each invocation transfers at
most one copy. Queue order and redelivery flags can change during inspection.

```sh
receipt='<64-character receipt from inspection>'
bun run nx run user:failures-replay --environment=development --run=default --message="$receipt" --limit=100
# Select the receipt from Wallet inspection for a Wallet replay:
bun run nx run wallet:failures-replay --environment=development --run=default --message="$receipt" --limit=100
```

The installed application's decoder validates the envelope and supported
version again before publication. User also validates the original AMQP
identities and named `replyTo`. Restore that original reply queue first as a
nonexclusive queue (prefer durable); replay checks its existence and leaves the
command retained if it is missing or exclusively owned by another connection.
It cannot change `replyTo`. Eligibility is a contract check, not a guarantee
that operational prerequisites still hold. A reply queue can disappear after
the check; observe the command result and the User API before another attempt.

| JSON status          | Outcome                                                                                                                                                    |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `retained`           | Invalid/unsupported contract or command properties; no publication or business change. Direct operator process exits 2.                                    |
| `not-found-in-scan`  | No matching ready message within the selected page; nothing acknowledged. Direct process exits 3. Re-inspect, page with `--offset`, or increase the limit. |
| `broker-accepted`    | Persistent, mandatory publication confirmed without a return; then the retained copy is acknowledged. `applicationCompleted` is always `false`.            |
| Diagnostic on stderr | Connection, topology, reply preflight, return, NACK, timeout or interruption; nonzero exit. Inspect again before retrying.                                 |

Nx propagates failures as a nonzero target result and may normalize the direct
process's exit code. Both inspection and replay targets have `cache: false`;
each invocation executes against the live selected broker.

## Durable ownership and completion

The original remains unacknowledged until the destination accepts the persistent
publication and confirms it without a routing return. Failed, returned or
unconfirmed publication leaves the original recoverable on connection close.
There is no automatic retry in the operator. Messaging work is bounded to 15
seconds (connection setup 2 seconds, cleanup 2 seconds).

An interruption after publication but before source acknowledgement can leave
both copies. This is intentional at-least-once delivery. Wallet's durable event
deduplication and unique User identity preserve the existing Wallet and balance.
User commands have no cached-response/exactly-once guarantee: a repeated creation
can return `USER.ALREADY_EXISTS`. Restore and consume the original reply queue;
do not interpret a repeated email conflict as the first attempt having failed.

**Broker acceptance is not application commit or consumer completion.** Observe
the User command reply and User API, or the Wallet REST/GraphQL lookup. A pending
User outbox publication is a separate workflow described in [recovery](recovery.md).

Real RabbitMQ component tests cover immutable inspection, invalid/unsupported
replay, eligible and repeated replay, routing returns, NACKs, lost confirmations,
process termination and transport loss. Integration tests cover the actual Nx
commands, environment rejection, fresh repeated inspection, and poison-message
retention across broker/application restart. See [developer checks](developer-checks.md).

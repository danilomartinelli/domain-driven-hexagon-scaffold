# User/Wallet contract evolution

User owns `user.created`. The supported production wire version is **1**, on
`user.events` / `user.created.v1`; Wallet and the explicit replay command validate
it before business execution. Unsupported versions stay in the failure queue
without creating a Wallet or a consumed-event record. A version number describes
semantics, not a service release number.

## Initial compatibility baseline

There are no historical release binaries in this test matrix. The fixed
[v1 JSON](../tests/compatibility/fixtures/user-created-v1.json) and
[baseline decoder](../tests/compatibility/fixtures/baseline-consumer.ts) establish
the initial protocol reference. The decoder was frozen from `e8caf10`; it does
not import the current contract, User/Wallet classes or application bootstrap.
The JSON is the same literal as the package's original baseline fixture.
Keep these fixtures fixed when changing production code. Add a new fixture for
a new supported contract; do not regenerate the baseline from today's producer.

The [additive producer](../tests/compatibility/fixtures/additive-producer.ts) and
[additive consumer](../tests/compatibility/fixtures/additive-consumer.ts) are
**test-only compatible candidates**, not shipped service versions. The producer
adds optional `traceparent` and `data.producerHint` fields without changing v1
identity or business meaning. The consumer recognizes optional tracing and
accepts its absence. Old consumers ignore both additions. Neither field is
required for Wallet creation, and no production feature or schema is added.

The infrastructure-free [matrix](../tests/compatibility/contracts.test.ts) runs
the following actual combinations, in both JSON-string and UTF-8 forms:

| Producer input                                       | Frozen baseline decoder     | Additive candidate decoder | Current production decoder  |
| ---------------------------------------------------- | --------------------------- | -------------------------- | --------------------------- |
| Fixed baseline JSON                                  | Accepted                    | Accepted without tracing   | Accepted                    |
| Additive candidate mapper                            | Accepted, additions ignored | Accepted with tracing      | Accepted, additions ignored |
| Either input with version 2 or missing User identity | Rejected                    | Rejected                   | Rejected                    |

The [User mapper test](../src/apps/user/tests/unit/user-created-contract.test.ts)
separately checks the current producer against the fixed literal without Nest.
Wallet's owned [consumer tests](../src/apps/wallet/tests/unit/user-created-consumer.test.ts)
cover validation before transaction entry and delivery context into its plain use
case. No test imports another application's implementation.

## Retained messages and independent transitions

The v1 JSON identity contract remains compatible with retained Unicode values
up to 255 UTF-16 code units. AMQP's optional `messageId` and `correlationId`
properties have a separate 255-byte UTF-8 limit. User mirrors only identities
that fit into those properties and preserves every identity in the immutable
envelope. Wallet and its replay validator read that envelope, so oversized
retained identities need neither rewriting nor a new version. Existing User
outbox rows resume publication after upgrading the publisher. Inspect the body
with `--payload` when a failure-queue record has no AMQP identity property;
replay preserves its original bytes, properties and receipt semantics.

The [User publication component test](../src/apps/user/tests/component/publication.test.ts)
exercises real retained envelopes on both sides of the AMQP byte boundary, while
the [system regression](../tests/integration/user-wallet.test.ts) verifies that
accepted multibyte REST metadata does not block its Wallet or later registrations.

The [live scenario](../tests/integration/contract-compatibility.test.ts) provisions
real PostgreSQL databases, RabbitMQ and Kong. Test preloads substitute only the
User wire mapper or Wallet decoder in separate application processes; the real
transactions, outbox publisher, consumer, deduplication, APIs and replay CLI run.
This is a protocol implementation transition in current service shells, not an
old-to-new release-binary upgrade test.

1. With User stopped, retain the fixed baseline envelope in its outbox. Seed two
   identical copies of a separate fixed [quarantined v1 record](../tests/compatibility/fixtures/retained-failure-v1.json)
   into the durable failure queue. This models a previously quarantined message;
   it does not claim today's decoder rejects valid v1. Send an unsupported v2
   through the actual consumer to establish rejection without business writes.
2. Start User with the additive mapper while Wallet still uses its current
   decoder. Deliver the old outbox record unchanged and create a fresh User to
   prove additive production works with the unchanged consumer.
3. Restart only Wallet with the additive decoder. Create a User with both
   additive candidates, then independently roll User back and create another
   User. Retained failures must remain byte/property/receipt identical.
4. Explicitly replay the retained baseline twice. Observe the original bytes and
   AMQP identity at the destination, then one zero-balance Wallet and one durable
   consumed-event identity. Refuse v2 replay and retain it without a Wallet.

Run the distinct targets from the repository root:

```sh
bun run nx run e2e:test                 # no infrastructure or app bootstrap; cacheable
bun run nx run integration-contracts:test # schema validation; cacheable
bun run nx run user:test               # includes the current producer mapping
bun run nx run e2e:test-compatibility   # real persistence/broker; never cached
```

`bun run check` includes the infrastructure-free matrix via `test:unit`.
`bun run test:e2e` includes the retained-message scenario; therefore both CI's
distributed suite and `bun run check:full` execute it. The focused live target
uses the same owned environment wrapper and cleanup, with `cache: false`.

## Coexistence, retirement and replay

Optional additions must preserve the meaning of existing fields and accept old
messages where the additions are absent. Do not rename/remove required fields,
change identity meaning, require an optional field, or reinterpret a v1 fact in
place. Such changes need a distinct supported version and routing decision.
There is no implicit v2 support today.

For an incompatible change, expand Wallet and its replay validator to accept old
and new versions first, preserving durable event identity across both. Test the
supported combinations, then transition User producers independently. Avoid
emitting both versions of one fact as unrelated new event identities. Keep old
routing and decoders available during coexistence and rollback.

Before retiring a version, record evidence that no active or rollback-eligible
producer emits it, no pending User outbox envelope needs it, and no ready or
in-flight delivery, retry or retained failure still requires it. Inventory the
outbox by envelope type/version and `published_at IS NULL`; inspect all failure
queue pages with the [operator commands](failure-queues.md), under quiesced
consumers when a stable inventory is required. A zero ready count alone does not
prove absence of in-flight deliveries. Backups or externally retained messages
that may be replayed are also obligations; define their supported replay window
before retiring a decoder. Neither age nor a new package version proves safety.

Drain pending work and explicitly replay eligible failures with their original
bytes, event/message identity, correlation and causation. Validate eligibility
against the deployed destination consumer, not just an operator's newer local
package. Broker acceptance is not application completion: verify Wallet lookup
and durable deduplication before declaring recovery. Unsupported messages remain
retained until support is deployed or an explicit operator disposition is
recorded; never silently drop them, rewrite their version or regenerate identity.
Keep retirement blocked until every retained obligation has an explicit outcome.

Sharing `@starter/integration-contracts` is source reuse, not a lockstep deployment
requirement. Each service artifact carries the contract implementation it was
built with. Passing combinations and the retirement inventory govern independent
releases; a monorepo dependency update does not require deploying both services.

## Service-owned schema evolution

When concurrent service versions share an owned database, use
**expand / transition / contract** inside that service:

1. Expand with nullable columns, new tables or compatible indexes using that
   service's migrations. Old code and retained v1 envelopes must still work.
2. Deploy readers that handle old and new shapes, backfill locally, and transition
   writers while keeping rollback possible. Test both code versions against the
   expanded schema and retained-message scenarios before ending coexistence.
3. Contract only after old processes and rollback paths are retired, backfill is
   complete and retained/replay obligations no longer need the old shape. Then
   enforce new constraints or remove old columns in a separate owned migration.

User migrations change only User storage; Wallet migrations change only Wallet
storage. Wallet never reads the User database to interpret an event. No
cross-database migration or coordinated deployment is required. This change adds
no schema migration; these steps define the policy for future schema evolution.

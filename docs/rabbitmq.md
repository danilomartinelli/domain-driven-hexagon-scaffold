# RabbitMQ messaging roles

`@starter/rabbitmq/consumer` owns consumer connections, topology, confirmations,
acknowledgement, failure retention and drain. Application adapters decode their
envelopes and run their own use cases. User, Wallet and generated applications
use this entry point; fixes reach generated adapters through the shared package.
`@starter/rabbitmq/publisher` owns publication through the same private session
supervisor. Both roles expose readiness with `snapshot()`; the diagnostics
recorder is private and has no public entry point.

```ts
import { RabbitConsumer } from '@starter/rabbitmq/consumer';

const consumer = new RabbitConsumer({
  connection: { hostname: 'localhost' },
  service: 'example',
  queue: 'example.commands',
  failureQueue: 'example.commands.failed',
  prefetch: 4,
  deliveryDeadlineMs: 10_000,
  logger,
  async handler(delivery, context) {
    context.signal.throwIfAborted();
    const result = await handle(delivery.content);
    return result.accepted
      ? { status: 'completed' }
      : { status: 'retained', reason: result.reason };
  },
});
consumer.start();
```

An optional `binding: { exchange, routingKey }` declares a durable direct
exchange and binds the durable queue. The failure queue is always explicit.
`Delivery` is package-owned and accepts consumed or fetched AMQP messages;
adapters need no AMQP client import. Its `content`, `properties` and `fields`
also fit existing envelope decoders and failure-queue validation.

Handlers can use `context.reply(queue, body, properties)` to send a persistent,
mandatory reply that must be confirmed before acknowledgement. Use
`context.identify({ messageId, correlationId, eventId, commandId })` to attach
decoded identity to failure logs when it differs from or cannot fit the optional
AMQP properties. This changes neither the body nor retained metadata. The package
never interprets an application's envelope.

## Publishers

```ts
import { RabbitPublisher } from '@starter/rabbitmq/publisher';

const publisher = new RabbitPublisher({
  connection: { hostname: 'localhost' },
  service: 'example',
  exchange: 'example.events',
  routingKey: 'example.created.v1',
  queues: ['recipient.example-created'],
  logger,
  claim: (publish) =>
    outbox.publishNext(async (event) => {
      await publish({
        body: Buffer.from(event.body),
        messageId: event.eventId,
        correlationId: event.correlationId,
        type: 'example.created',
        contentType: 'application/json',
      });
    }),
});
publisher.start();
```

The publisher declares a durable direct exchange and each durable queue/binding
before accepting claims. The application owns claiming and marking work complete;
`claim(publish)` returns whether a unit completed. An empty claim waits a fixed
250 ms before another attempt. Publication is persistent, mandatory and confirmed;
a return or missing confirmation ends the session and rejects publication, so
completion remains the application's recovery responsibility.

Publication preserves the body exactly. Optional `messageId` and `correlationId`
properties exceeding 255 UTF-8 bytes are omitted, while the full identities remain
available in failure logs. The immutable envelope stays authoritative.

`stop()` stops new claims and waits for the current claim, including a publication
started after shutdown. Its publication uses the session signal; shutdown does
not interrupt a broker confirmation already being awaited.

## Sessions and drain

`start()` is idempotent and independent of HTTP startup. `snapshot()` returns
`connected`, `failures`, `retries`, `retryDelayMs` and `lastFailureAt` directly
for readiness probes. A blocked broker connection is not connected for readiness.

Connection attempts take at most two seconds and each broker operation at most
five seconds. Reconnection starts at 250 ms, doubles to ten seconds, and resets
only after an acknowledged delivery or a completed publisher claim. These resilience timings belong to the package.
User keeps prefetch 1 and a 15-second delivery deadline; Wallet and generated
consumers keep prefetch 4 and a ten-second deadline.

The handler signal aborts on deadline expiry or session loss, never on shutdown.
A deadline stops waiting but cannot cancel application effects. The session
closes without ACK; both drain and reconnection wait for the actual handler to
settle. Other instances can receive the redelivery while that handler still
runs, so application idempotence remains necessary.

`stop()` marks readiness unavailable, cancels new deliveries, waits for accepted
handlers and their acknowledgements, then closes the channel before the
connection. The applications' [15-second shutdown deadline](shutdown.md) remains
the outer bound; unfinished work requires recovery on restart.

## Retention and logs

Retention preserves original bytes, string message/correlation identities,
reply address, content type, content encoding, type and original headers. It is
persistent and mandatory, carries no expiration and requires broker confirmation
before the source ACK. These headers describe the original delivery:

| Header                 | Meaning                      |
| ---------------------- | ---------------------------- |
| `failure-reason`       | Application rejection reason |
| `original-exchange`    | Source exchange              |
| `original-routing-key` | Source routing key           |
| `original-redelivered` | Source redelivery flag       |

New headers deliberately avoid RabbitMQ's reserved `x-` vocabulary. Already
retained deliveries keep their old headers; [inspection and replay](failure-queues.md)
remain compatible and do not rewrite historical evidence.

Consumer lifecycle operations are `consumer.connected`, `consumer.unavailable`,
`consumer.retry`, `consumer.failed` and `consumer.retained`. Records identify
the service and queue, available delivery identity, retry delay where applicable,
and `errorType` (the error class). They contain no raw errors, stack traces,
payloads or connection details. Retained records also name the rejection reason.
Publisher lifecycle operations are `publisher.connected`, `publisher.unavailable`,
`publisher.retry` and `publisher.failed`. They follow the same logging policy and
identify the exchange; a failed claim includes its latest publication identity
when it reached `publish`, using `messageId` and its `eventId` alias plus
`correlationId`. Failures before publication carry no stale identity.

Business logs stay with their applications: `user.create.committed`,
`user.create.rejected`, `wallet.event.committed`, `outbox.confirmed`,
`outbox.published` and generated `consumer.completed`.

## Contract tests

`bun run nx run rabbitmq:test-component` exercises the public package against an
owned real RabbitMQ broker, using the broker gate for lost confirmations and
connections. It participates in `bun run test:component`. Application and generator
suites retain their envelope, business outcome, recovery and shutdown checks.

# RabbitMQ consumers

`@starter/rabbitmq/consumer` owns consumer connections, topology, confirmations,
acknowledgement, failure retention and drain. Application adapters decode their
envelopes and run their own use cases. User, Wallet and generated applications
use this entry point; fixes reach generated adapters through the shared package.

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

## Sessions and drain

`start()` is idempotent and independent of HTTP startup. `snapshot()` returns
`connected`, `failures`, `retries`, `retryDelayMs` and `lastFailureAt` directly
for readiness probes. A blocked broker connection is not connected for readiness.

Connection attempts take at most two seconds and each broker operation at most
five seconds. Reconnection starts at 250 ms, doubles to ten seconds, and resets
only after acknowledged work. These resilience timings belong to the package.
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
Business logs stay with their applications: `user.create.committed`,
`user.create.rejected`, `wallet.event.committed` and generated `consumer.completed`.

## Contract tests

`bun run nx run rabbitmq:test-component` exercises the public package against an
owned real RabbitMQ broker, using the broker gate for lost confirmations and
connections. It participates in `bun run test:component`. Application and generator
suites retain their envelope, business outcome, recovery and shutdown checks.

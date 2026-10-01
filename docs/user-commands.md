# User creation commands

The User process starts an independent RabbitMQ consumer alongside HTTP,
GraphQL and its outbox publisher. Run the application using the
[User setup](user.md#run-it-locally). No Wallet process is required. The consumer
uses the existing `RABBITMQ_HOST`, `RABBITMQ_PORT`, `RABBITMQ_USERNAME`,
`RABBITMQ_PASSWORD` and `RABBITMQ_VHOST` settings and loads no dotenv files.

## Contract

| Destination                   | Value                            |
| ----------------------------- | -------------------------------- |
| Durable direct exchange       | `user.commands`                  |
| Routing key and durable queue | `user.create`                    |
| Durable inspection queue      | `user.create.failed`             |
| Reply destination             | Producer's named `replyTo` queue |

This command is separate from the `user.events` / `user.created.v1` integration
event consumed by Wallet. The [decoder](../src/apps/user/messaging/user-create.contract.ts)
and [independent v1 fixture](../src/apps/user/tests/unit/fixtures/user-create-v1.json)
define the accepted envelope:

```json
{
  "type": "user.create",
  "version": 1,
  "commandId": "create-profile-001",
  "correlationId": "signup-001",
  "data": {
    "email": "command@example.com",
    "country": "England",
    "street": "Baker street",
    "postalCode": "NW16XE"
  }
}
```

Send UTF-8 JSON with persistent delivery, mandatory routing and publisher
confirmations. AMQP `messageId` must equal `commandId`, and AMQP `correlationId`
must equal the envelope's `correlationId`. Both identities are nonblank text,
at most 255 UTF-8 bytes, without NUL or lone surrogates. Supply an existing,
named `replyTo` queue; RabbitMQ Direct Reply-To is unsupported. A durable reply
queue supports recovery across producer restarts; the example uses an exclusive
temporary queue for an interactive request.

Email uses the same email validator and 5–320 character limits as the REST DTO.
Country is 4–50 ASCII letters/spaces, street is 5–50 ASCII letters/spaces, and
postal code is 4–10 ASCII alphanumeric characters. Extra fields are ignored,
including any supplied role. Unsupported types/versions, malformed JSON/UTF-8,
invalid profile data and missing/mismatched AMQP metadata never invoke creation.

After committing the User and pending integration event together, the consumer
sends persistent JSON to `replyTo`, with matching AMQP `messageId` and
`correlationId`:

```json
{
  "type": "user.create.result",
  "version": 1,
  "commandId": "create-profile-001",
  "correlationId": "signup-001",
  "result": { "id": "3e5aa9d4-4b58-4acf-bcf6-d45cd83b50d1" }
}
```

An existing email returns the same envelope with
`"error": { "code": "USER.ALREADY_EXISTS", "message": "User already exists" }`
instead of `result`, without another profile or event. The command identity is
outbox `causationId`; correlation is copied explicitly, and each delivery gets
its own operation timestamp. No HTTP request context is needed.

## Execute a command

With User running, execute this from the repository root. It uses the installed
AMQP client, creates a reply queue, sends a command and prints its response.
Each invocation uses a fresh email; use a fixed email to observe conflicts.

```sh
bun run env:exec --environment=development --run=default -- bun --eval '
import { connect } from "amqplib";
const connection = await connect({
  hostname: process.env.RABBITMQ_HOST,
  port: Number(process.env.RABBITMQ_PORT),
  username: process.env.RABBITMQ_USERNAME,
  password: process.env.RABBITMQ_PASSWORD,
  vhost: process.env.RABBITMQ_VHOST,
}, { timeout: 2000 });
try {
  const channel = await connection.createConfirmChannel();
  const { queue } = await channel.assertQueue("", { exclusive: true });
  const commandId = crypto.randomUUID();
  const correlationId = crypto.randomUUID();
  const command = {
    type: "user.create", version: 1, commandId, correlationId,
    data: { email: `${commandId}@example.com`, country: "England",
      street: "Baker street", postalCode: "NW16XE" },
  };
  let returned = false;
  channel.on("return", () => { returned = true; });
  channel.publish("user.commands", "user.create", Buffer.from(JSON.stringify(command)), {
    persistent: true, mandatory: true, contentType: "application/json",
    messageId: commandId, correlationId, replyTo: queue,
  });
  await channel.waitForConfirms();
  if (returned) throw new Error("Command was not routed");
  const deadline = Date.now() + 15000;
  for (;;) {
    const reply = await channel.get(queue, { noAck: false });
    if (reply) {
      console.log(reply.content.toString());
      channel.ack(reply);
      break;
    }
    if (Date.now() >= deadline) throw new Error("Response timed out; inspect before retrying");
    await Bun.sleep(50);
  }
} finally {
  await connection.close();
}
'
```

## Failures and diagnostics

The consumer ACKs only after a local commit (or business rejection) and a
routed, broker-confirmed response. Invalid commands receive no RPC response:
the original bytes and identity/reply properties are copied persistently to
`user.create.failed`, with `user-command-failure-reason` and original exchange /
routing-key headers. Expiration is omitted so inspection work is retained.
Only a routed, confirmed failure copy permits acknowledgement of the original.
There is no automatic consumer on the inspection queue.

Connection, database and reply/failure-publication errors close the consumer
connection, leaving unacknowledged commands recoverable. Reconnect delay starts
at 250ms and doubles to 10s, resetting after completed work. Connection setup
times out after 2s, messaging operations after 5s, and a delivery after 15s;
database connection and statement waits use the existing 5s bounds. Shutdown
interrupts both messaging lifecycles before closing the database pool.

There is **no command exactly-once or cached-response contract**. If commit
succeeds but the reply or acknowledgement is lost, redelivery can return the
existing-email conflict. `commandId` is tracing metadata, not a deduplication
key. A timeout or publisher confirmation alone does not establish application
success, failure or Wallet completion. Check the User API and outbox before
resubmitting an uncertain creation. An expired producer reply queue can keep
the command retrying; restore that named queue to receive the eventual outcome.

Use the RabbitMQ management UI for the selected environment (its assigned
management port is in the environment manifest). Inspect `user.create`,
`user.create.failed` and the producer reply queue, including ready versus
unacknowledged counts. For **Get messages**, select requeue to preserve evidence.
Read `user-command-failure-reason`, `messageId`, `correlationId` and the original
bytes. Correct the producer contract before sending a new command; unsupported
versions need a compatible consumer. General operator replay tooling is a later
slice of [ADR 0002](adr/0002-adopt-nx-with-nest-and-bun.md#implementation-status).

Logs distinguish `User command consumer connected`, `User command committed`,
business rejection, retained validation failure and delivery recovery. Publisher
logs remain independent. Inspect `user_outbox.envelope` by `causationId` or
`correlationId` using User owner credentials; `published_at IS NULL` means
pending publication, and a non-null value does not prove Wallet processing.

## Verification

```sh
bun run nx run user:test
bun scripts/with-test-database.ts --app=user -- bun test --preload ./src/apps/user/tests/component/preload.ts ./src/apps/user/tests/component/user-create-command.test.ts
```

The contract suite runs with Bun alone. Component tests use the real external
User process, PostgreSQL and RabbitMQ without Wallet. They cover creation,
duplicate email, invalid retention, rollback before acknowledgement, disconnected
startup/recovery, independent publication during consumer topology failure,
broker cancellation, unroutable failure retention and lost reply confirmations.

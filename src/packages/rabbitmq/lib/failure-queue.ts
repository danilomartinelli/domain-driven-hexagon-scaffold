import { createHash } from 'node:crypto';
import { connect, type GetMessage, type Options } from 'amqplib';

interface Destination {
  queue: string;
  failureQueue: string;
}

type Validation =
  | { accepted: true; requiredQueues?: readonly string[] }
  | { accepted: false; reason: string };
type Validate = (message: GetMessage) => Validation;

function textProperty(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function parseArguments(args: string[]) {
  const [action, ...flags] = args;
  if (action !== 'inspect' && action !== 'replay')
    throw new Error('Expected inspect or replay');
  const seen = new Set<string>();
  let limit = 20;
  let offset = 0;
  let message: string | undefined;
  let payload = false;
  for (const flag of flags) {
    const name = flag.split('=')[0] ?? '';
    if (seen.has(name)) throw new Error('Duplicate option');
    seen.add(name);
    if (/^--limit=\d+$/.test(flag)) limit = Number(flag.slice(8));
    else if (/^--offset=\d+$/.test(flag)) offset = Number(flag.slice(9));
    else if (/^--message=[a-f0-9]{64}$/.test(flag)) message = flag.slice(10);
    else if (flag === '--payload') payload = true;
    else throw new Error('Unknown or invalid option');
  }
  if (limit < 1 || limit > 1000) throw new Error('Limit must be 1..1000');
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(offset + limit))
    throw new Error('Offset must be a safe nonnegative integer');
  if (action === 'replay' ? !message || payload : message)
    throw new Error('Replay requires --message; --payload is inspection only');
  return { action, limit, offset, message, payload };
}

function receipt(message: GetMessage): string {
  // Delivery tags/redelivery flags change on inspection. Stored bytes and AMQP
  // properties do not; identical retained copies intentionally share a selector.
  return createHash('sha256')
    .update(message.content)
    .update(JSON.stringify(message.properties))
    .digest('hex');
}

async function within<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  const failed = Promise.withResolvers<never>();
  const abort = () => {
    failed.reject(new Error('Operation interrupted'));
  };
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  try {
    return await Promise.race([operation, failed.promise]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

/** One bounded operator invocation; application-owned validation stays at the caller. */
export async function runFailureQueueCli(
  options: Options.Connect,
  destination: Destination,
  validate: Validate,
): Promise<void> {
  const shutdown = new AbortController();
  const interrupt = () => {
    shutdown.abort();
  };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  try {
    const args = parseArguments(process.argv.slice(2));
    const signal = AbortSignal.any([
      shutdown.signal,
      AbortSignal.timeout(15_000),
    ]);
    // amqplib forwards socket options to net.connect, including cancellation.
    const socketOptions = { timeout: 2_000, signal };
    const connection = await connect(options, socketOptions);
    const disconnected = new AbortController();
    const session = AbortSignal.any([signal, disconnected.signal]);
    const end = () => {
      disconnected.abort();
    };
    connection.on('error', end);
    connection.on('close', end);
    try {
      const channel = await within(connection.createConfirmChannel(), session);
      channel.on('error', end);
      channel.on('close', end);
      const returns = new Set<unknown>();
      channel.on('return', () => {
        returns.add(true);
      });
      // Never create/rebind destinations during recovery: missing topology must
      // remain visible and must not make an unroutable replay look successful.
      const initial = await within(
        channel.checkQueue(destination.failureQueue),
        session,
      );
      const messages = [];
      let scanned = 0;
      for (
        let count = 0;
        count < Math.min(initial.messageCount, args.offset + args.limit);
        count++
      ) {
        const message = await within(
          channel.get(destination.failureQueue, { noAck: false }),
          session,
        );
        if (!message) break;
        if (count < args.offset) continue;
        scanned++;
        const key = receipt(message);
        const validation = validate(message);
        if (args.action === 'inspect') {
          messages.push({
            receipt: key,
            messageId: textProperty(message.properties.messageId),
            correlationId: textProperty(message.properties.correlationId),
            eligible: validation.accepted,
            ...(!validation.accepted ? { reason: validation.reason } : {}),
            ...(args.payload
              ? {
                  contentBase64: message.content.toString('base64'),
                  properties: message.properties,
                }
              : {}),
          });
        } else if (key === args.message) {
          if (!validation.accepted) {
            console.log(
              JSON.stringify({
                status: 'retained',
                receipt: key,
                reason: validation.reason,
              }),
            );
            process.exitCode = 2;
            return;
          }
          session.throwIfAborted();
          for (const queue of validation.requiredQueues ?? [])
            await within(channel.checkQueue(queue), session);
          channel.sendToQueue(destination.queue, message.content, {
            ...message.properties,
            expiration: undefined,
            persistent: true,
            mandatory: true,
          });
          await within(channel.waitForConfirms(), session);
          session.throwIfAborted();
          if (returns.size) throw new Error('Replay was returned');
          // Ownership transfers only after confirmed durable routing. Any crash
          // before this ACK leaves the original available for another attempt.
          channel.ack(message);
          await within(channel.close(), signal);
          console.log(
            JSON.stringify({
              status: 'broker-accepted',
              receipt: key,
              destination: destination.queue,
              applicationCompleted: false,
            }),
          );
          return;
        }
      }
      if (args.action === 'inspect') {
        console.log(
          JSON.stringify({
            queue: destination.failureQueue,
            ready: initial.messageCount,
            offset: args.offset,
            messages,
          }),
        );
      } else {
        console.log(
          JSON.stringify({
            status: 'not-found-in-scan',
            scanned,
          }),
        );
        process.exitCode = 3;
      }
    } finally {
      // Close requeues every unacknowledged inspection/invalid/skipped delivery.
      await within(connection.close(), AbortSignal.timeout(2_000));
    }
  } catch {
    // Broker errors may contain credentials or payload-dependent details.
    console.error(
      'Failure-queue operation failed or was interrupted. Work not acknowledged remains retained; an uncertain replay may already be delivered. Check arguments, environment and broker topology.',
    );
    process.exitCode = 1;
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
  }
}

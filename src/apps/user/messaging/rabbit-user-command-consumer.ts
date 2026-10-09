import { randomUUID } from 'node:crypto';
import type { LoggerPort } from '@starter/core/logger';
import {
  RabbitConsumer,
  type ConnectionOptions,
  type ConsumerContext,
  type ConsumerOutcome,
  type Delivery,
} from '@starter/rabbitmq/consumer';
import type { CreateUser } from '../application/create-user';
import {
  decodeUserCreateDelivery,
  userCreateDestination,
  type UserCreateResponse,
} from './user-create.contract';

/** Decodes commands and records business outcomes; the package owns delivery. */
export class RabbitUserCommandConsumer extends RabbitConsumer {
  constructor(
    connection: ConnectionOptions,
    create: CreateUser,
    logger: LoggerPort,
  ) {
    const { queue, failureQueue, exchange, routingKey } = userCreateDestination;
    super({
      connection,
      queue,
      failureQueue,
      binding: { exchange, routingKey },
      prefetch: 1,
      deliveryDeadlineMs: 15_000,
      service: 'user',
      logger,
      handler: (delivery, context) =>
        handleCommand(delivery, context, create, logger),
    });
  }
}

async function handleCommand(
  message: Delivery,
  context: ConsumerContext,
  create: CreateUser,
  logger: LoggerPort,
): Promise<ConsumerOutcome> {
  const { signal } = context;
  context.identify({
    commandId:
      typeof message.properties.messageId === 'string'
        ? message.properties.messageId
        : undefined,
  });
  const decoded = decodeUserCreateDelivery(message.content, message.properties);
  if (!decoded.accepted) {
    return { status: 'retained', reason: decoded.reason };
  }
  const { commandId, correlationId, data } = decoded.command;
  const { replyTo } = decoded;
  signal.throwIfAborted();
  const createdAt = new Date();
  const eventId = randomUUID();
  const result = await create.execute(
    { ...data, id: randomUUID(), eventId, createdAt },
    { correlationId, causationId: commandId, timestamp: createdAt.getTime() },
  );
  const response: UserCreateResponse = {
    type: 'user.create.result',
    version: 1,
    commandId,
    correlationId,
    ...(result.isOk()
      ? { result: { id: result.unwrap() } }
      : {
          error: {
            code: result.unwrapErr().code,
            message: result.unwrapErr().message,
          },
        }),
  };
  logger.log(
    result.isOk()
      ? 'User command committed.'
      : 'User command rejected by business rules.',
    {
      service: 'user',
      operation: result.isOk()
        ? 'user.create.committed'
        : 'user.create.rejected',
      ...(result.isOk() ? { eventId } : {}),
      commandId,
      correlationId,
    },
  );
  await context.reply(replyTo, Buffer.from(JSON.stringify(response)), {
    contentType: 'application/json',
    messageId: commandId,
    correlationId,
    type: response.type,
  });
  return { status: 'completed' };
}

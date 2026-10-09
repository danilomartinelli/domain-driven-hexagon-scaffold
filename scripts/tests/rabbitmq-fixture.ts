import { connect, type ConfirmChannel } from 'amqplib';
import { randomUUID } from 'node:crypto';
import type { LoggerPort } from '@starter/core/logger';
import { assertTestEnvironment } from '../../database/environment';
import { brokerGate } from './broker-gate';
import { withCleanup } from './cleanup';

export async function eventually(
  check: () => void | Promise<void>,
  timeout = 12_000,
): Promise<void> {
  const deadline = Date.now() + timeout;
  for (;;) {
    try {
      await check();
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await Bun.sleep(25);
    }
  }
}

export async function withRabbitmq(
  scenario: (fixture: {
    channel: ConfirmChannel;
    gate: Awaited<ReturnType<typeof brokerGate>>;
    connection: {
      hostname: string;
      port: number;
      username: string;
      password: string;
      vhost: string;
    };
    queue: string;
    failureQueue: string;
    exchange: string;
    logger: LoggerPort;
    records: Record<string, unknown>[];
    arguments: unknown[];
    roles: { stop(): Promise<void> }[];
  }) => Promise<void>,
): Promise<void> {
  assertTestEnvironment();
  const options = {
    hostname: String(process.env.RABBITMQ_HOST),
    port: Number(process.env.RABBITMQ_PORT),
    username: String(process.env.RABBITMQ_USERNAME),
    password: String(process.env.RABBITMQ_PASSWORD),
    vhost: String(process.env.RABBITMQ_VHOST),
  };
  const gate = await brokerGate(options);
  gate.allow();
  await withCleanup(async () => {
    const connection = await connect(options, { timeout: 2_000 });
    const roles: { stop(): Promise<void> }[] = [];
    await withCleanup(async () => {
      const channel = await connection.createConfirmChannel();
      const queue = `contract-${randomUUID()}`;
      const records: Record<string, unknown>[] = [];
      const args: unknown[] = [];
      const record = (message: string, ...meta: unknown[]) => {
        args.push(message, ...meta);
        for (const item of meta)
          if (typeof item === 'object' && item !== null)
            records.push({ message, ...item });
      };
      await scenario({
        channel,
        gate,
        connection: { ...options, port: Number(gate.port) },
        queue,
        failureQueue: `${queue}.failed`,
        exchange: `${queue}.events`,
        logger: { log: record, warn: record, error: record, debug: record },
        records,
        arguments: args,
        roles,
      });
    }, [
      () =>
        withCleanup(
          () => Promise.resolve(),
          roles.map((role) => () => role.stop()),
        ),
      () => connection.close(),
    ]);
  }, [() => gate.close()]);
}

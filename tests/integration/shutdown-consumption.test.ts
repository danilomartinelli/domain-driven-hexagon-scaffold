import { expect, test } from 'bun:test';
import request from 'supertest';
import { connect } from 'amqplib';
import { sql } from 'slonik';
import { withCleanup } from '../../scripts/tests/cleanup';
import { eventually } from '@tests/setup/operations';
import {
  getHttpServer,
  getTestDatabase,
  getWalletDatabase,
  user,
  wallet,
} from '@tests/setup/test-server';
import { blockedQuery, withTableLock } from '@tests/setup/shutdown';

test('SIGINT cancels new deliveries and finishes Wallet commit and ACK before closing its connection', async () => {
  await eventually(async () => {
    await request(wallet.url).get('/health/ready/consumer').expect(200);
  });
  const pool = getWalletDatabase();
  await withTableLock(pool, 'wallets', async (release) => {
    await getHttpServer()
      .post('/v1/users')
      .send({
        email: 'wallet-drain@example.com',
        country: 'England',
        street: 'Baker street',
        postalCode: 'NW16XE',
      })
      .expect(201);
    await blockedQuery(pool, 'wallet_runtime', 'INSERT INTO wallets');
    wallet.signal('SIGINT');
    await eventually(() => {
      expect(wallet.output).toContain('shutdown.started');
    });
    await request(wallet.url).get('/health/ready/consumer').expect(503);
    await release();
    expect(await wallet.waitForExit()).toEqual({ code: 0, forced: false });
    expect(
      await pool.any(sql.unsafe`SELECT event_id FROM wallet_consumed_events`),
    ).toHaveLength(1);
    const connection = await connect(
      {
        hostname: process.env.RABBITMQ_HOST,
        port: Number(process.env.RABBITMQ_PORT),
        username: process.env.RABBITMQ_USERNAME,
        password: process.env.RABBITMQ_PASSWORD,
        vhost: process.env.RABBITMQ_VHOST,
      },
      { timeout: 2_000 },
    );
    await withCleanup(async () => {
      const channel = await connection.createChannel();
      expect(await channel.get('wallet.user-created', { noAck: false })).toBe(
        false,
      );
    }, [() => connection.close()]);
  });
}, 45_000);

test('SIGTERM finishes a User command response and ACK while leaving new commands queued for restart', async () => {
  await eventually(async () => {
    await request(user.url).get('/health/ready/consumer').expect(200);
  });
  const connection = await connect(
    {
      hostname: process.env.RABBITMQ_HOST,
      port: Number(process.env.RABBITMQ_PORT),
      username: process.env.RABBITMQ_USERNAME,
      password: process.env.RABBITMQ_PASSWORD,
      vhost: process.env.RABBITMQ_VHOST,
    },
    { timeout: 2_000 },
  );
  await withCleanup(async () => {
    const channel = await connection.createConfirmChannel();
    const reply = await channel.assertQueue('', { exclusive: true });
    const publish = async (commandId: string) => {
      channel.sendToQueue(
        'user.create',
        Buffer.from(
          JSON.stringify({
            type: 'user.create',
            version: 1,
            commandId,
            correlationId: commandId,
            data: {
              email: `${commandId}@example.com`,
              country: 'England',
              street: 'Baker street',
              postalCode: 'NW16XE',
            },
          }),
        ),
        {
          persistent: true,
          messageId: commandId,
          correlationId: commandId,
          replyTo: reply.queue,
        },
      );
      await channel.waitForConfirms();
    };
    await withTableLock(getTestDatabase(), 'user_outbox', async (release) => {
      await publish('command-draining');
      await blockedQuery(
        getTestDatabase(),
        'user_runtime',
        'INSERT INTO user_outbox',
      );
      user.signal('SIGTERM');
      await eventually(async () => {
        await request(user.url).get('/health/ready/consumer').expect(503);
      });
      await publish('command-after-signal');
      await release();
      expect(await user.waitForExit()).toEqual({ code: 0, forced: false });
      const result = await channel.get(reply.queue, { noAck: true });
      if (!result)
        throw new Error('In-flight command did not return a response');
      expect(JSON.parse(result.content.toString())).toMatchObject({
        type: 'user.create.result',
        commandId: 'command-draining',
        result: { id: expect.any(String) as unknown },
      });
      const pending = await channel.get('user.create', { noAck: false });
      if (!pending) throw new Error('New command was lost during shutdown');
      expect(pending.properties.messageId).toBe('command-after-signal');
      channel.nack(pending, false, true);
      await eventually(async () => {
        expect((await channel.checkQueue('user.create')).messageCount).toBe(1);
      });
    });
    await user.start();
    await eventually(async () => {
      expect(
        await getTestDatabase().any(
          sql.unsafe`SELECT email FROM users ORDER BY email`,
        ),
      ).toEqual([
        { email: 'command-after-signal@example.com' },
        { email: 'command-draining@example.com' },
      ]);
      expect((await channel.checkQueue('user.create')).messageCount).toBe(0);
    });
  }, [() => connection.close()]);
}, 45_000);

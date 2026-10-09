import { expect, test } from 'bun:test';
import { connect } from 'amqplib';
import request from 'supertest';
import { sql, type DatabasePool } from 'slonik';
import { withCleanup } from '../../scripts/tests/cleanup';
import { eventually } from '@tests/setup/operations';
import { blockedQuery, withTableLock } from '@tests/setup/shutdown';
import {
  getTestDatabase,
  getWalletDatabase,
  user,
  wallet,
} from '@tests/setup/test-server';

// Extend only this transaction's next statement so a real database lock can
// outlive the delivery deadline without changing production timeout settings.
async function withLongStatement(
  pool: DatabasePool,
  table: string,
  scenario: () => Promise<void>,
): Promise<void> {
  await pool.query(sql.unsafe`
    CREATE FUNCTION extend_delivery_statement() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      PERFORM set_config('statement_timeout', '60s', true);
      RETURN NEW;
    END $$
  `);
  await withCleanup(async () => {
    await pool.query(sql.unsafe`
      CREATE TRIGGER extend_delivery_statement BEFORE INSERT ON ${sql.identifier([table])}
      FOR EACH ROW EXECUTE FUNCTION extend_delivery_statement()
    `);
    await scenario();
  }, [
    () =>
      pool.query(sql.unsafe`
      DROP TRIGGER IF EXISTS extend_delivery_statement ON ${sql.identifier([table])}
    `),
    () => pool.query(sql.unsafe`DROP FUNCTION extend_delivery_statement()`),
  ]);
}

for (const name of ['user', 'wallet'] as const) {
  test(`${name} drains a real handler past its delivery deadline before completing shutdown`, async () => {
    const service = name === 'user' ? user : wallet;
    const pool = name === 'user' ? getTestDatabase() : getWalletDatabase();
    const queue = name === 'user' ? 'user.create' : 'wallet.user-created';
    const table = name === 'user' ? 'user_outbox' : 'wallets';
    const identity = `expired-${name}`;
    const committed =
      name === 'user' ? 'user.create.committed' : 'wallet.event.committed';
    await eventually(async () => {
      await request(service.url).get('/health/ready/consumer').expect(200);
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
      const body = Buffer.from(
        JSON.stringify(
          name === 'user'
            ? {
                type: 'user.create',
                version: 1,
                commandId: identity,
                correlationId: identity,
                data: {
                  email: `${identity}@example.com`,
                  country: 'England',
                  street: 'Baker street',
                  postalCode: 'NW16XE',
                },
              }
            : {
                type: 'user.created',
                version: 1,
                source: 'user',
                eventId: identity,
                occurredAt: '2026-10-09T12:00:00Z',
                correlationId: identity,
                causationId: identity,
                data: { userId: identity },
              },
        ),
      );
      await withLongStatement(
        pool,
        name === 'user' ? 'users' : 'wallet_consumed_events',
        async () => {
          await withTableLock(pool, table, async (release) => {
            channel.sendToQueue(queue, body, {
              persistent: true,
              messageId: identity,
              correlationId: identity,
              replyTo: reply.queue,
            });
            await channel.waitForConfirms();
            await blockedQuery(pool, `${name}_runtime`, `INSERT INTO ${table}`);
            await eventually(() => {
              expect(service.output).toContain('consumer.failed');
            });
            service.signal('SIGTERM');
            await eventually(() => {
              expect(service.output).toContain('shutdown.started');
            });
            await Bun.sleep(400);
            expect(service.output).not.toContain('shutdown.completed');
            await release();
            expect(await service.waitForExit()).toEqual({
              code: 0,
              forced: false,
            });
            const operations = service.output
              .split('\n')
              .filter((line) => line.includes(committed));
            expect(operations).toHaveLength(1);
            expect(service.output.indexOf(committed)).toBeLessThan(
              service.output.indexOf('shutdown.completed'),
            );
            const pending = await channel.get(queue, { noAck: false });
            if (!pending) throw new Error('Expired delivery was lost');
            expect(pending.content).toEqual(body);
            expect(pending.fields.redelivered).toBe(true);
            channel.nack(pending, false, true);
          });
        },
      );
      await service.start();
      await eventually(() => {
        expect(service.output).toContain(
          name === 'user' ? 'user.create.rejected' : committed,
        );
      });
      await service.stop();
      expect((await channel.checkQueue(queue)).messageCount).toBe(0);
      expect((await channel.checkQueue(`${queue}.failed`)).messageCount).toBe(
        0,
      );
      expect(
        await pool.any(
          sql.unsafe`SELECT * FROM ${sql.identifier([name === 'user' ? 'users' : 'wallets'])}`,
        ),
      ).toHaveLength(1);
      expect(
        await pool.any(
          sql.unsafe`SELECT event_id FROM ${sql.identifier([name === 'user' ? 'user_outbox' : 'wallet_consumed_events'])}`,
        ),
      ).toHaveLength(1);
    }, [() => connection.close()]);
  }, 60_000);
}

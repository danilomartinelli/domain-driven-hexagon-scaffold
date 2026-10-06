import { expect, test } from 'bun:test';
import { connect } from 'amqplib';
import { withCleanup } from './cleanup';
import {
  distributionBroker,
  until,
  withDistribution,
} from './distribution-fixture';

test('Wallet container stop acknowledges drained work and recovers the same delivery after its deadline', async () => {
  await withDistribution(
    'wallet',
    async ({ owner, start, stop, probe, databaseFault }) => {
      if (!probe || !databaseFault)
        throw new Error('This lifecycle check requires an OCI image');
      const broker = await connect(distributionBroker(), { timeout: 2000 });
      await withCleanup(async () => {
        const channel = await broker.createConfirmChannel();
        await channel.assertExchange('user.events', 'direct', {
          durable: true,
        });
        await channel.assertQueue('wallet.user-created', { durable: true });
        await channel.bindQueue(
          'wallet.user-created',
          'user.events',
          'user.created.v1',
        );
        for (const mode of ['drain', 'timeout']) {
          await start();
          await owner.query(
            'BEGIN; LOCK TABLE wallets IN ACCESS EXCLUSIVE MODE',
          );
          const event = {
            type: 'user.created',
            source: 'user',
            version: 1,
            eventId: `container-${mode}`,
            occurredAt: '2026-10-05T12:00:00Z',
            correlationId: `container-${mode}`,
            causationId: 'container-command',
            data: { userId: `container-${mode}` },
          };
          const body = Buffer.from(JSON.stringify(event));
          channel.publish('user.events', 'user.created.v1', body, {
            persistent: true,
            mandatory: true,
            messageId: event.eventId,
            contentType: 'application/json',
          });
          await channel.waitForConfirms();
          let paused = false;
          let stopped: Promise<void> | undefined;
          try {
            await until(async () => {
              await owner.query('SELECT pg_stat_clear_snapshot()');
              return (
                (
                  await owner.query(
                    "SELECT pid FROM pg_stat_activity WHERE usename = 'wallet_runtime' AND wait_event_type = 'Lock' AND query ILIKE '%wallets%'",
                  )
                ).rows.length > 0
              );
            });
            if (mode === 'timeout') {
              await databaseFault('pause');
              paused = true;
            }
            const started = Date.now();
            // The consumer's 10s operation timeout can finish cleanup before the
            // 15s application deadline. Either exit must preserve the delivery.
            stopped = stop(mode === 'timeout' ? [0, 1] : 0);
            await until(
              async () =>
                (await probe('/health/ready/consumer')).status === 503,
            );
            await until(
              async () =>
                (await channel.checkQueue('wallet.user-created'))
                  .consumerCount === 0,
            );
            if (mode === 'drain') await owner.query('COMMIT');
            await stopped;
            if (mode === 'timeout') {
              expect(Date.now() - started).toBeGreaterThanOrEqual(9_000);
              expect(Date.now() - started).toBeLessThan(20_000);
              await databaseFault('unpause');
              paused = false;
              await owner.query('ROLLBACK');
            }
            expect(
              (await owner.query('SELECT id FROM wallets')).rows,
            ).toHaveLength(mode === 'drain' ? 1 : 0);
            expect(
              (await owner.query('SELECT event_id FROM wallet_consumed_events'))
                .rows,
            ).toHaveLength(mode === 'drain' ? 1 : 0);
            await until(
              async () =>
                (await channel.checkQueue('wallet.user-created'))
                  .messageCount === (mode === 'drain' ? 0 : 1),
            );
            if (mode === 'timeout') {
              const retained = await channel.get('wallet.user-created', {
                noAck: false,
              });
              if (!retained)
                throw new Error(
                  'Accepted delivery was lost during container stop',
                );
              expect(retained.fields.redelivered).toBe(true);
              expect(retained.content).toEqual(body);
              expect(retained.properties.messageId).toBe(event.eventId);
              channel.nack(retained, false, true);
            }
            await start();
            await until(
              async () =>
                (await owner.query('SELECT id FROM wallets')).rows.length === 1,
            );
            await stop();
            expect(
              (await owner.query('SELECT event_id FROM wallet_consumed_events'))
                .rows,
            ).toEqual([{ event_id: event.eventId }]);
            expect(
              (await channel.checkQueue('wallet.user-created')).messageCount,
            ).toBe(0);
            expect(
              (await channel.checkQueue('wallet.user-created.failed'))
                .messageCount,
            ).toBe(0);
          } finally {
            if (paused) await databaseFault('unpause');
            await owner.query('ROLLBACK');
            await stopped;
          }
          await stop();
          await owner.query('TRUNCATE wallets, wallet_consumed_events');
        }
      }, [() => withCleanup(stop, [() => broker.close()])]);
    },
  );
}, 360_000);

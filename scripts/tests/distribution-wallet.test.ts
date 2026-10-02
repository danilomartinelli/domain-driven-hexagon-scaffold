import { expect, test } from 'bun:test';
import { connect } from 'amqplib';
import { withCleanup } from './cleanup';
import {
  distributionBroker,
  until,
  withDistribution,
} from './distribution-fixture';

test('isolated Wallet migrates, looks up absence and consumes a User event using only its own resources', async () => {
  await withDistribution('wallet', async ({ owner, http, start, stop }) => {
    const broker = await connect(distributionBroker(), { timeout: 2_000 });
    await withCleanup(async () => {
      const channel = await broker.createConfirmChannel();
      await channel.assertExchange('user.events', 'direct', { durable: true });
      await channel.assertQueue('wallet.user-created', { durable: true });
      await channel.bindQueue(
        'wallet.user-created',
        'user.events',
        'user.created.v1',
      );
      await start();
      await http.get('/v1/wallets/by-user/artifact-user').expect(404);
      expect(
        (
          await http
            .post('/graphql')
            .send({
              query:
                '{ walletByUser(userId: "artifact-user") { id userId balance } }',
            })
            .expect(200)
        ).body,
      ).toEqual({ data: { walletByUser: null } });
      const event = {
        type: 'user.created',
        source: 'user',
        version: 1,
        eventId: 'artifact-event',
        occurredAt: '2026-10-02T12:00:00.000Z',
        correlationId: 'artifact-correlation',
        causationId: 'artifact-command',
        data: { userId: 'artifact-user' },
      };
      channel.publish(
        'user.events',
        'user.created.v1',
        Buffer.from(JSON.stringify(event)),
        {
          persistent: true,
          mandatory: true,
          messageId: event.eventId,
          contentType: 'application/json',
        },
      );
      await channel.waitForConfirms();
      await until(
        async () =>
          (await http.get('/v1/wallets/by-user/artifact-user')).status === 200,
      );
      const wallet = (
        await http.get('/v1/wallets/by-user/artifact-user').expect(200)
      ).body as unknown;
      expect(wallet).toMatchObject({ userId: 'artifact-user', balance: 0 });
      expect(
        (
          await http
            .post('/graphql')
            .send({
              query:
                '{ walletByUser(userId: "artifact-user") { id userId balance } }',
            })
            .expect(200)
        ).body,
      ).toEqual({ data: { walletByUser: wallet } });
      expect(
        (await owner.query('SELECT event_id FROM wallet_consumed_events')).rows,
      ).toEqual([{ event_id: 'artifact-event' }]);
      await stop();
      await start();
      expect(
        (await http.get('/v1/wallets/by-user/artifact-user').expect(200)).body,
      ).toEqual(wallet);
    }, [
      async () => {
        await withCleanup(stop, [() => broker.close()]);
      },
    ]);
  });
}, 120_000);

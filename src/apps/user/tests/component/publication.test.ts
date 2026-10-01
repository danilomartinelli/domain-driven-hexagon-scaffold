import { expect, test } from 'bun:test';
import { connect } from 'amqplib';
import { withCleanup } from '../../../../../scripts/tests/cleanup';
import { getHttpServer, ownerDatabase } from './user-process';

test('neither rolled-back nor committed creation publishes in the pending-only slice', async () => {
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
    await channel.assertExchange('user.events', 'direct', { durable: true });
    await channel.assertQueue('wallet.user-created', { durable: true });
    await channel.bindQueue(
      'wallet.user-created',
      'user.events',
      'user.created.v1',
    );
    const owner = ownerDatabase();
    await owner.query('REVOKE INSERT ON user_outbox FROM user_runtime');
    await withCleanup(async () => {
      await getHttpServer()
        .post('/v1/users')
        .send({
          email: 'rollback@example.com',
          country: 'England',
          street: 'Baker street',
          postalCode: 'NW16XE',
        })
        .expect(500);
      expect((await owner.query('SELECT * FROM users')).rows).toEqual([]);
      expect((await owner.query('SELECT * FROM user_outbox')).rows).toEqual([]);
      expect(
        (await channel.checkQueue('wallet.user-created')).messageCount,
      ).toBe(0);
    }, [() => owner.query('GRANT INSERT ON user_outbox TO user_runtime')]);
    await getHttpServer()
      .post('/v1/users')
      .send({
        email: 'committed@example.com',
        country: 'England',
        street: 'Baker street',
        postalCode: 'NW16XE',
      })
      .expect(201);
    expect(
      (
        await owner.query(
          'SELECT * FROM user_outbox WHERE published_at IS NULL',
        )
      ).rows,
    ).toHaveLength(1);
    expect((await channel.checkQueue('wallet.user-created')).messageCount).toBe(
      0,
    );
  }, [() => connection.close()]);
});

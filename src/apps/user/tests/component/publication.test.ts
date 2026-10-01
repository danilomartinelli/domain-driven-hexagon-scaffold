import { expect, test } from 'bun:test';
import { connect } from 'amqplib';
import { withCleanup } from '../../../../../scripts/tests/cleanup';
import {
  getHttpServer,
  ownerDatabase,
  stopUser,
  startUser,
} from './user-process';

test('only committed creation is routed persistently and confirmed while Wallet is stopped', async () => {
  await stopUser();
  await startUser({ RABBITMQ_PORT: String(process.env.RABBITMQ_PORT) });
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
    const deadline = Date.now() + 8_000;
    while (
      (
        await owner.query(
          'SELECT * FROM user_outbox WHERE published_at IS NULL',
        )
      ).rowCount !== 0
    ) {
      if (Date.now() > deadline)
        throw new Error('Committed event was not published');
      await Bun.sleep(50);
    }
    const message = await channel.get('wallet.user-created', { noAck: true });
    expect(message).not.toBe(false);
    if (!message) throw new Error('Missing committed event');
    const { rows } = await owner.query<{ envelope: unknown }>(
      'SELECT envelope FROM user_outbox',
    );
    expect(JSON.parse(message.content.toString()) as unknown).toEqual(
      rows[0]?.envelope,
    );
    expect(message.properties.deliveryMode).toBe(2);
    expect((await channel.checkQueue('wallet.user-created')).messageCount).toBe(
      0,
    );
  }, [() => connection.close()]);
}, 20_000);

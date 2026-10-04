import { expect, test } from 'bun:test';
import { connect } from 'amqplib';
import { z } from 'zod';
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

test('retained Unicode identities publish unchanged without exceeding AMQP property byte limits', async () => {
  await stopUser();
  const envelopes = [
    'é'.repeat(127),
    `${'é'.repeat(127)}a`,
    'é'.repeat(128),
  ].map((identity, index) => ({
    type: 'user.created',
    version: 1,
    source: 'user',
    eventId: identity,
    correlationId: identity,
    causationId: `retained-command-${String(index)}`,
    occurredAt: '2026-09-30T12:00:00.000Z',
    data: { userId: `retained-user-${String(index)}` },
  }));
  // These are already-persisted v1 envelopes, not new producer output.
  for (const envelope of envelopes) {
    await ownerDatabase().query(
      'INSERT INTO user_outbox (event_id, envelope) VALUES ($1, $2)',
      [envelope.eventId, JSON.stringify(envelope)],
    );
  }
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
    await startUser({ RABBITMQ_PORT: String(process.env.RABBITMQ_PORT) });
    const deadline = Date.now() + 8_000;
    while (
      (
        await ownerDatabase().query(
          'SELECT 1 FROM user_outbox WHERE published_at IS NULL',
        )
      ).rowCount !== 0
    ) {
      if (Date.now() > deadline)
        throw new Error('Retained Unicode identities stranded the outbox');
      await Bun.sleep(50);
    }
    const channel = await connection.createChannel();
    const receivedIdentities: string[] = [];
    for (const envelope of envelopes) {
      const message = await channel.get('wallet.user-created', { noAck: true });
      if (!message) throw new Error('Missing retained event');
      const received = z
        .object({ eventId: z.string() })
        .loose()
        .parse(JSON.parse(message.content.toString()));
      // Find by identity rather than depending on equal-timestamp row order.
      const original = envelopes.find(
        (entry) => entry.eventId === received.eventId,
      );
      receivedIdentities.push(received.eventId);
      if (!original) throw new Error('Unexpected retained event identity');
      expect(received).toEqual(original);
      const property =
        Buffer.byteLength(received.eventId, 'utf8') <= 255
          ? received.eventId
          : undefined;
      expect(message.properties.messageId).toBe(property);
      expect(message.properties.correlationId).toBe(property);
      expect(message.properties.deliveryMode).toBe(2);
      expect(
        (
          await ownerDatabase().query<{ envelope: unknown }>(
            'SELECT envelope FROM user_outbox WHERE event_id = $1',
            [envelope.eventId],
          )
        ).rows[0]?.envelope,
      ).toEqual(envelope);
    }
    expect(receivedIdentities.sort()).toEqual(
      envelopes.map((envelope) => envelope.eventId).sort(),
    );
    expect((await channel.checkQueue('wallet.user-created')).messageCount).toBe(
      0,
    );
  }, [() => connection.close()]);
}, 20_000);

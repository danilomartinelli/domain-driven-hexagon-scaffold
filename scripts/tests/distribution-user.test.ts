import { expect, test } from 'bun:test';
import { connect } from 'amqplib';
import { withCleanup } from './cleanup';
import { availablePort } from '../lib/environments';
import {
  distributionBroker,
  until,
  withDistribution,
} from './distribution-fixture';

test('isolated User migrates and commits REST/GraphQL creation with its broker and Wallet unavailable', async () => {
  await withDistribution('user', async ({ owner, http, start, stop }) => {
    const unavailable = { RABBITMQ_PORT: String(await availablePort()) };
    await start(unavailable);
    const profile = {
      email: 'artifact@example.com',
      country: 'England',
      street: 'Baker street',
      postalCode: 'NW16XE',
    };
    await http.post('/v1/users').send(profile).expect(201);
    const graphql = await http
      .post('/graphql')
      .send({
        query:
          'mutation Create($input: CreateUserGqlRequestDto!) { create(input: $input) { id } }',
        variables: {
          input: { ...profile, email: 'graphql-artifact@example.com' },
        },
      })
      .expect(200);
    expect(graphql.body).toHaveProperty('data.create.id');
    expect(graphql.body).not.toHaveProperty('errors');
    const pending = await owner.query(
      'SELECT envelope, published_at FROM user_outbox ORDER BY event_id',
    );
    expect(pending.rows).toHaveLength(2);
    expect(pending.rows).toEqual([
      expect.objectContaining({ published_at: null }),
      expect.objectContaining({ published_at: null }),
    ]);
    await stop();
    await start(unavailable);
    expect((await http.get('/v1/users').expect(200)).body).toMatchObject({
      count: 2,
    });
    expect(
      (
        await owner.query(
          'SELECT envelope, published_at FROM user_outbox ORDER BY event_id',
        )
      ).rows,
    ).toEqual(pending.rows);
    await stop();
    const broker = await connect(distributionBroker(), { timeout: 2_000 });
    await withCleanup(async () => {
      const channel = await broker.createConfirmChannel();
      await channel.assertExchange('user.commands', 'direct', {
        durable: true,
      });
      await channel.assertQueue('user.create', { durable: true });
      await channel.bindQueue('user.create', 'user.commands', 'user.create');
      const { queue } = await channel.assertQueue('', { exclusive: true });
      await start();
      channel.publish(
        'user.commands',
        'user.create',
        Buffer.from(
          JSON.stringify({
            type: 'user.create',
            version: 1,
            commandId: 'artifact-command',
            correlationId: 'artifact-correlation',
            data: { ...profile, email: 'message-artifact@example.com' },
          }),
        ),
        {
          persistent: true,
          mandatory: true,
          replyTo: queue,
          messageId: 'artifact-command',
          correlationId: 'artifact-correlation',
          contentType: 'application/json',
        },
      );
      await channel.waitForConfirms();
      let response: unknown;
      await until(async () => {
        const reply = await channel.get(queue, { noAck: true });
        if (!reply) return false;
        response = JSON.parse(reply.content.toString());
        return true;
      });
      expect(response).toMatchObject({
        type: 'user.create.result',
        commandId: 'artifact-command',
      });
      expect(response).toHaveProperty('result.id');
      expect((await http.get('/v1/users').expect(200)).body).toMatchObject({
        count: 3,
      });
      expect(
        (
          await owner.query(
            "SELECT envelope FROM user_outbox WHERE envelope->>'causationId' = 'artifact-command'",
          )
        ).rows,
      ).toHaveLength(1);
    }, [
      async () => {
        await withCleanup(stop, [() => broker.close()]);
      },
    ]);
  });
}, 120_000);

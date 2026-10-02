import { expect, test } from 'bun:test';
import request from 'supertest';
import { user, wallet } from '@tests/setup/test-server';
import { getHttpServer } from '@tests/setup/test-server';
import { z } from 'zod';
import { connect } from 'amqplib';
import { withCleanup } from '../../scripts/tests/cleanup';
import {
  docker,
  eventually,
  eventLogs,
  ownedContainer,
  restore,
} from '@tests/setup/operations';

test('operators can probe liveness and each applicable readiness independently', async () => {
  for (const service of [user, wallet]) {
    const api = request(service.url);
    const live = await api.get('/health/live').expect(200);
    expect(live.body).toEqual({ service: service.name, status: 'alive' });
    await api.get('/health/ready/http').expect(200);
    await eventually(async () => {
      await api.get('/health/ready').expect(200);
    });
    const ready = await api.get('/health/ready').expect(200);
    expect(ready.body).toMatchObject({
      service: service.name,
      http: { status: 'ready' },
      consumer: { status: 'ready' },
      publisher: {
        status: service.name === 'user' ? 'ready' : 'not_applicable',
      },
    });
    const publisher = await api.get('/health/ready/publisher').expect(200);
    expect(publisher.body).toMatchObject({
      status: service.name === 'user' ? 'ready' : 'not_applicable',
    });
    await api.get('/health/ready/unknown').expect(404);
  }
});

const backlogSchema = z.object({
  status: z.literal('available'),
  pendingCount: z.number(),
  oldestAgeSeconds: z.number().nullable(),
});
async function backlog() {
  return backlogSchema.parse(
    (await request(user.url).get('/health/backlog').expect(200)).body,
  );
}

test('broker outage preserves usable APIs and persistent backlog; recovery drains it with the original event correlation', async () => {
  const broker = await ownedContainer('rabbitmq');
  let committed: ReturnType<typeof eventLogs> = [];
  await withCleanup(async () => {
    await docker(['stop', '--time', '3', broker]);
    for (const service of [user, wallet]) {
      await eventually(async () => {
        await request(service.url).get('/health/ready/consumer').expect(503);
      });
      await request(service.url).get('/health/live').expect(200);
      await request(service.url).get('/health/ready/http').expect(200);
    }
    await request(user.url).get('/health/ready/publisher').expect(503);
    await request(wallet.url).get('/health/ready/publisher').expect(200);
    await user.stop();
    await wallet.stop();
    const startedAt = Date.now();
    await user.start();
    await wallet.start();
    expect(Date.now() - startedAt).toBeLessThan(8_000);
    expect(await backlog()).toMatchObject({
      pendingCount: 0,
      oldestAgeSeconds: null,
    });
    await getHttpServer()
      .post('/v1/users')
      .send({
        requestId: 'incident-rest',
        email: 'incident-rest@example.com',
        country: 'England',
        street: 'Baker street',
        postalCode: 'NW16XE',
      })
      .expect(201);
    await eventually(async () => {
      expect((await backlog()).pendingCount).toBe(1);
    });
    const graphql = await getHttpServer()
      .post('/user/graphql')
      .send({
        query:
          'mutation { create(input: { email: "incident-graphql@example.com", country: "England", street: "Baker street", postalCode: "NW16XE" }) { id } }',
      })
      .expect(200);
    expect(graphql.body).toHaveProperty('data.create.id');
    await getHttpServer().get('/v1/users').expect(200);
    const lookup = await getHttpServer()
      .post('/wallet/graphql')
      .send({ query: '{ walletByUser(userId: "pending") { id } }' })
      .expect(200);
    expect(lookup.body).toEqual({ data: { walletByUser: null } });
    await eventually(async () => {
      const pending = await backlog();
      expect(pending.pendingCount).toBe(2);
      expect(pending.oldestAgeSeconds).toBeGreaterThan(0);
    });
    committed = eventLogs(user).filter(
      ({ operation }) => operation === 'user.create.committed',
    );
    expect(committed).toHaveLength(2);
    expect(
      committed.some(({ correlationId }) => correlationId === 'incident-rest'),
    ).toBe(true);
    await user.stop();
    await user.start();
    expect((await backlog()).pendingCount).toBe(2);
    const before = z
      .object({
        retries: z.number(),
        failures: z.number(),
        retryDelayMs: z.number(),
      })
      .parse(
        (await request(user.url).get('/health/ready/publisher').expect(503))
          .body,
      );
    await Promise.all(
      Array.from({ length: 20 }, async () => {
        await request(user.url).get('/health/ready/publisher').expect(503);
      }),
    );
    const after = z
      .object({ retries: z.number() })
      .parse((await request(user.url).get('/health/ready/publisher')).body);
    expect(after.retries - before.retries).toBeLessThanOrEqual(1);
    await eventually(async () => {
      const state = z
        .object({
          failures: z.number(),
          retries: z.number(),
          retryDelayMs: z.number(),
        })
        .parse((await request(user.url).get('/health/ready/publisher')).body);
      expect(state.failures).toBeGreaterThan(0);
      expect(state.retries).toBeGreaterThan(0);
      expect(state.retryDelayMs).toBeGreaterThanOrEqual(250);
    });
  }, [() => restore(broker)]);
  await eventually(async () => {
    expect(await backlog()).toMatchObject({
      pendingCount: 0,
      oldestAgeSeconds: null,
    });
  });
  for (const service of [user, wallet]) {
    await eventually(async () => {
      await request(service.url).get('/health/ready').expect(200);
    });
  }
  await eventually(() => {
    for (const { eventId, correlationId } of committed) {
      expect(eventLogs(user)).toContainEqual({
        service: 'user',
        operation: 'outbox.published',
        eventId,
        correlationId,
      });
      expect(eventLogs(wallet)).toContainEqual({
        service: 'wallet',
        operation: 'wallet.event.committed',
        eventId,
        correlationId,
      });
    }
  });
}, 90_000);

test('database loss degrades only its owner while liveness and the sibling APIs remain usable', async () => {
  for (const [owner, sibling] of [
    [user, wallet],
    [wallet, user],
  ]) {
    const database = await ownedContainer(`postgres-${owner.name}`);
    await withCleanup(async () => {
      await docker(['pause', database]);
      await eventually(async () => {
        const startedAt = Date.now();
        const health = await request(owner.url)
          .get('/health/ready')
          .timeout(7_000)
          .expect(503);
        expect(Date.now() - startedAt).toBeLessThan(7_000);
        expect(health.body).toMatchObject({
          http: { status: 'not_ready' },
          consumer: { status: 'not_ready', reason: 'database_unavailable' },
        });
        for (const value of [
          process.env.USER_DB_PASSWORD,
          process.env.WALLET_DB_PASSWORD,
          process.env.RABBITMQ_PASSWORD,
        ]) {
          if (value) expect(health.text).not.toContain(value);
        }
        expect(health.text).not.toMatch(
          /envelope|email|street|password|postgres:\/\//i,
        );
      });
      await request(owner.url).get('/health/live').expect(200);
      await request(sibling.url).get('/health/ready/http').expect(200);
      await request(sibling.url).get('/health/ready').expect(200);
      const path =
        sibling.name === 'user' ? '/v1/users' : '/v1/wallets/by-user/absent';
      await getHttpServer()
        .get(path)
        .expect(sibling.name === 'user' ? 200 : 404);
      if (owner.name === 'user') {
        const pending = await request(user.url)
          .get('/health/backlog')
          .expect(503);
        expect(pending.body).toEqual({
          service: 'user',
          status: 'unavailable',
        });
      }
    }, [
      async () => {
        await docker(['unpause', database]);
      },
    ]);
    await eventually(async () => {
      await request(owner.url).get('/health/ready').expect(200);
    });
  }
}, 90_000);

test('a RabbitMQ command is traceable through publication and Wallet commit; queue diagnostics expose retained failures', async () => {
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
    const { queue } = await channel.assertQueue('', { exclusive: true });
    channel.sendToQueue(
      'user.create',
      Buffer.from(
        JSON.stringify({
          type: 'user.create',
          version: 1,
          commandId: 'incident-command',
          correlationId: 'incident-command-correlation',
          data: {
            email: 'incident-command@example.com',
            country: 'England',
            street: 'Baker street',
            postalCode: 'NW16XE',
          },
        }),
      ),
      {
        persistent: true,
        replyTo: queue,
        messageId: 'incident-command',
        correlationId: 'incident-command-correlation',
      },
    );
    await channel.waitForConfirms();
    await eventually(async () => {
      const message = await channel.get(queue, { noAck: true });
      expect(message).not.toBe(false);
      if (!message) throw new Error('Waiting for command result');
      expect(JSON.parse(message.content.toString()) as unknown).toHaveProperty(
        'result.id',
      );
    });
    await eventually(() => {
      const committed = eventLogs(user).find(
        ({ operation, correlationId }) =>
          operation === 'user.create.committed' &&
          correlationId === 'incident-command-correlation',
      );
      expect(committed).toBeDefined();
      if (!committed) throw new Error('Waiting for commit log');
      const { eventId, correlationId } = committed;
      expect(eventLogs(user)).toContainEqual({
        service: 'user',
        operation: 'outbox.published',
        eventId,
        correlationId,
      });
      expect(eventLogs(wallet)).toContainEqual({
        service: 'wallet',
        operation: 'wallet.event.committed',
        eventId,
        correlationId,
      });
    });
    channel.sendToQueue('wallet.user-created', Buffer.from('invalid-event'), {
      persistent: true,
      messageId: 'failed-incident',
      correlationId: 'failed-correlation',
    });
    channel.sendToQueue('user.create', Buffer.from('invalid-command'), {
      persistent: true,
      messageId: 'failed-command',
      correlationId: 'failed-correlation',
    });
    await channel.waitForConfirms();
    await eventually(async () => {
      expect(
        (await channel.checkQueue('wallet.user-created.failed')).messageCount,
      ).toBe(1);
      expect(
        (await channel.checkQueue('user.create.failed')).messageCount,
      ).toBe(1);
    });
    const broker = await ownedContainer('rabbitmq');
    const queues = await docker([
      'exec',
      broker,
      'rabbitmqctl',
      '-q',
      'list_queues',
      '-p',
      String(process.env.RABBITMQ_VHOST),
      'name',
      'messages_ready',
      'messages_unacknowledged',
      'consumers',
      'state',
      '--formatter=json',
    ]);
    const states = z
      .array(
        z.object({
          name: z.string(),
          messages_ready: z.number(),
          messages_unacknowledged: z.number(),
          consumers: z.number(),
          state: z.string(),
        }),
      )
      .parse(JSON.parse(queues));
    for (const name of ['user.create', 'wallet.user-created']) {
      expect(states.find((state) => state.name === name)).toMatchObject({
        messages_ready: 0,
        messages_unacknowledged: 0,
        consumers: 1,
        state: 'running',
      });
      expect(
        states.find((state) => state.name === `${name}.failed`),
      ).toMatchObject({ messages_ready: 1, consumers: 0, state: 'running' });
    }
  }, [() => connection.close()]);
}, 60_000);

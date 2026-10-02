import { expect, test } from 'bun:test';
import { connect } from 'amqplib';
import { sql } from 'slonik';
import { z } from 'zod';
import {
  getHttpServer,
  getTestDatabase,
  getWalletDatabase,
  user,
  wallet,
} from '@tests/setup/test-server';
import { assertTestEnvironment } from '../../database/environment';
import { runCommand } from '../../scripts/lib/command';
import { withCleanup } from '../../scripts/tests/cleanup';
import baseline from '../compatibility/fixtures/user-created-v1.json';
import retained from '../compatibility/fixtures/retained-failure-v1.json';

const producerPreload = './tests/compatibility/fixtures/preload-producer.ts';
const consumerPreload = './tests/compatibility/fixtures/preload-consumer.ts';
const failureQueue = 'wallet.user-created.failed';
const inspection = z.object({
  ready: z.number(),
  messages: z.array(
    z.object({
      receipt: z.string(),
      messageId: z.string(),
      correlationId: z.string(),
      eligible: z.boolean(),
      contentBase64: z.string(),
      properties: z.unknown(),
    }),
  ),
});

async function until(condition: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 20_000;
  while (!(await condition())) {
    if (Date.now() > deadline)
      throw new Error(
        `Compatibility transition timed out\n${user.output}\n${wallet.output}`,
      );
    await Bun.sleep(50);
  }
}

async function observe(userId: string) {
  let result: unknown;
  await until(async () => {
    const response = await getHttpServer()
      .get(`/v1/wallets/by-user/${userId}`)
      .timeout(2_000);
    if (response.status !== 200) return false;
    result = response.body;
    return true;
  });
  expect(result).toMatchObject({ userId, balance: 0 });
  return result;
}

async function create(email: string) {
  const response = await getHttpServer()
    .post('/v1/users')
    .send({
      email,
      country: 'England',
      street: 'Baker street',
      postalCode: 'NW16XE',
    })
    .expect(201);
  return z.object({ id: z.string() }).parse(response.body).id;
}

async function failures(args: string[], additive = false) {
  return runCommand(
    [
      process.execPath,
      ...(additive ? ['--preload', consumerPreload] : []),
      'src/apps/wallet/messaging/failures.ts',
      ...args,
    ],
    { cwd: process.cwd(), timeout: 30_000 },
  );
}

async function inspect(additive = false) {
  const result = await failures(['inspect', '--payload'], additive);
  expect(result.code).toBe(0);
  return inspection.parse(JSON.parse(result.stdout));
}

test('retained v1 outbox and failures survive independent compatible protocol implementation transitions', async () => {
  assertTestEnvironment();
  await until(() => wallet.output.includes('Wallet messaging connected.'));
  await user.stop();
  await getTestDatabase().query(sql.unsafe`
    INSERT INTO user_outbox (event_id, envelope)
    VALUES (${baseline.eventId}, ${sql.jsonb(baseline)})
  `);
  expect(
    await getTestDatabase().any(sql.unsafe`
    SELECT event_id, envelope, published_at FROM user_outbox
  `),
  ).toEqual([
    { event_id: baseline.eventId, envelope: baseline, published_at: null },
  ]);

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
  connection.on('error', () => {
    /* Operations surface failures. */
  });
  await withCleanup(async () => {
    const channel = await connection.createConfirmChannel();
    const body = Buffer.from(JSON.stringify(retained));
    const properties = {
      persistent: true,
      messageId: retained.eventId,
      correlationId: retained.correlationId,
      headers: {
        'x-failure-reason': 'baseline-fixture-quarantine',
        trace: 'retained-trace',
      },
    };
    // A fixed, previously quarantined record; no claim that today's decoder rejects v1.
    channel.sendToQueue(failureQueue, body, properties);
    channel.sendToQueue(failureQueue, body, properties);
    const unsupported = {
      ...retained,
      eventId: 'unsupported-event',
      version: 2,
      data: { userId: 'unsupported-user' },
    };
    channel.sendToQueue(
      'wallet.user-created',
      Buffer.from(JSON.stringify(unsupported)),
      {
        persistent: true,
        messageId: unsupported.eventId,
        correlationId: retained.correlationId,
      },
    );
    await channel.waitForConfirms();
    await until(
      async () => (await channel.checkQueue(failureQueue)).messageCount === 3,
    );
    const before = await inspect();
    expect(before.messages.filter((message) => message.eligible)).toHaveLength(
      2,
    );
    expect(
      await getWalletDatabase().any(
        sql.unsafe`SELECT * FROM wallet_consumed_events`,
      ),
    ).toEqual([]);
    await getHttpServer()
      .get(`/v1/wallets/by-user/${retained.data.userId}`)
      .expect(404);

    // Upgrade User's mapper alone. The persisted baseline envelope must not be re-encoded.
    await user.start(producerPreload);
    await observe(baseline.data.userId);
    await until(
      async () =>
        (
          await getTestDatabase().any(sql.unsafe`
      SELECT event_id FROM user_outbox WHERE published_at IS NULL
    `)
        ).length === 0,
    );
    expect(
      await getTestDatabase().any(sql.unsafe`
      SELECT event_id, envelope FROM user_outbox WHERE event_id = ${baseline.eventId}
    `),
    ).toEqual([{ event_id: baseline.eventId, envelope: baseline }]);
    const additiveId = await create('additive-producer@example.com');
    await observe(additiveId); // additive producer -> current consumer
    const additiveEnvelope = await getTestDatabase().one(sql.unsafe`
      SELECT envelope FROM user_outbox WHERE envelope->'data'->>'userId' = ${additiveId}
    `);
    expect(
      z.object({ envelope: z.unknown() }).parse(additiveEnvelope).envelope,
    ).toMatchObject({
      version: 1,
      traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
      data: { userId: additiveId, producerHint: 'compatible-fixture' },
    });

    // Upgrade Wallet independently while User keeps its additive mapper.
    await wallet.stop();
    expect((await channel.checkQueue(failureQueue)).messageCount).toBe(3);
    await wallet.start(consumerPreload);
    await until(() => wallet.output.includes('Wallet messaging connected.'));
    await observe(await create('both-additive@example.com'));
    // Roll User back independently: missing optional fields remain accepted.
    await user.stop();
    await user.start();
    await observe(await create('baseline-producer@example.com'));
    expect(wallet.output).toContain('Compatible consumer fixture loaded');
    expect(await inspect(true)).toEqual(before);

    const eligible = before.messages.find(
      (message) => message.messageId === retained.eventId,
    );
    const rejected = before.messages.find(
      (message) => message.messageId === unsupported.eventId,
    );
    if (!eligible || !rejected) throw new Error('Missing retained fixtures');
    expect(eligible).toMatchObject({
      contentBase64: body.toString('base64'),
      correlationId: retained.correlationId,
      properties: {
        messageId: retained.eventId,
        headers: properties.headers,
        deliveryMode: 2,
      },
    });
    // Hold the consumer to inspect the actual replayed bytes and properties before processing.
    await wallet.stop();
    const replay = await failures(
      ['replay', `--message=${eligible.receipt}`],
      true,
    );
    expect(replay.code).toBe(0);
    expect(JSON.parse(replay.stdout)).toMatchObject({
      status: 'broker-accepted',
      applicationCompleted: false,
    });
    const replayed = await channel.get('wallet.user-created', { noAck: false });
    if (!replayed) throw new Error('Replay did not reach Wallet queue');
    expect(replayed.content).toEqual(body);
    const replayedProperties: unknown = replayed.properties;
    expect(replayedProperties).toEqual(eligible.properties);
    channel.nack(replayed, false, true);
    await wallet.start(consumerPreload);
    const first = await observe(retained.data.userId);
    expect(
      (await failures(['replay', `--message=${eligible.receipt}`], true)).code,
    ).toBe(0);
    await until(
      () =>
        (wallet.output.match(/eventId: 'retained-failure-event'/g) ?? [])
          .length === 2,
    );
    // Quiesce to observe durable deduplication after the duplicate was handled.
    await wallet.stop();
    expect(
      await getWalletDatabase().any(sql.unsafe`
      SELECT id FROM wallets WHERE "userId" = ${retained.data.userId}
    `),
    ).toEqual([{ id: z.object({ id: z.string() }).parse(first).id }]);
    expect(
      await getWalletDatabase().any(sql.unsafe`
      SELECT event_id, user_id, correlation_id, causation_id FROM wallet_consumed_events
      WHERE event_id IN (${baseline.eventId}, ${retained.eventId}) ORDER BY event_id
    `),
    ).toEqual([
      {
        event_id: baseline.eventId,
        user_id: baseline.data.userId,
        correlation_id: baseline.correlationId,
        causation_id: baseline.causationId,
      },
      {
        event_id: retained.eventId,
        user_id: retained.data.userId,
        correlation_id: retained.correlationId,
        causation_id: retained.causationId,
      },
    ]);
    const rejectedReplay = await failures(
      ['replay', `--message=${rejected.receipt}`],
      true,
    );
    expect(rejectedReplay.code).toBe(2);
    expect(JSON.parse(rejectedReplay.stdout)).toMatchObject({
      status: 'retained',
    });
    expect((await inspect(true)).messages).toEqual([rejected]);
    expect(
      await getWalletDatabase().any(sql.unsafe`
      SELECT event_id FROM wallet_consumed_events WHERE event_id = 'unsupported-event'
    `),
    ).toEqual([]);
    await wallet.start(consumerPreload);
    expect(await observe(retained.data.userId)).toEqual(first);
    await getHttpServer()
      .get('/v1/wallets/by-user/unsupported-user')
      .expect(404);
  }, [() => connection.close()]);
}, 120_000);

import { expect, test } from 'bun:test';
import { z } from 'zod';
import { withCleanup } from '../../../../../scripts/tests/cleanup';
import {
  destination,
  brokerOptions,
  eventually,
  publish,
  userCreated,
  withBroker,
} from './broker-fixture';
import {
  ownerDatabase,
  startWallet,
  stopWallet,
  walletOutput,
  walletUrl,
} from './wallet-process';
import { startConsumerWorker } from './worker-fixture';
import { brokerGate } from '../../../../../scripts/tests/broker-gate';

test('a confirmed RabbitMQ event eventually creates a zero-balance Wallet through both APIs without User', async () => {
  await withBroker(async (channel) => {
    await publish(channel, userCreated('event-api', 'user-api'));
    // Publisher confirmation alone is not completion: observe the committed Wallet.
    await eventually(async () => {
      const response = await fetch(
        `${walletUrl()}/v1/wallets/by-user/user-api`,
      );
      expect(response.status).toBe(200);
      const wallet: unknown = await response.json();
      expect(wallet).toMatchObject({ userId: 'user-api', balance: 0 });
      const graphql = await fetch(`${walletUrl()}/graphql`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: '{ walletByUser(userId: "user-api") { id userId balance } }',
        }),
      });
      expect(await graphql.json()).toEqual({ data: { walletByUser: wallet } });
    }, 3_000);
  });
}, 20_000);

test('concurrent deliveries across consumers create one Wallet and never replace its existing balance', async () => {
  const worker = startConsumerWorker();
  await withCleanup(async () => {
    await worker.waitFor('Wallet messaging connected.');
    await withBroker(async (channel) => {
      for (let i = 0; i < 12; i++) {
        await publish(
          channel,
          userCreated(`event-${String(i % 3)}`, 'user-concurrent'),
        );
      }
      await eventually(async () => {
        expect(
          (
            await ownerDatabase().query(
              'SELECT event_id FROM wallet_consumed_events',
            )
          ).rows.length,
        ).toBe(3);
        const response = await fetch(
          `${walletUrl()}/v1/wallets/by-user/user-concurrent`,
        );
        expect(await response.json()).toMatchObject({
          userId: 'user-concurrent',
          balance: 0,
        });
      });
      await ownerDatabase().query('UPDATE wallets SET balance = 91');
      for (let i = 0; i < 12; i++)
        await publish(
          channel,
          userCreated(`event-${String(i % 6)}`, 'user-concurrent'),
        );
      await eventually(async () => {
        expect(
          (
            await ownerDatabase().query(
              'SELECT event_id FROM wallet_consumed_events',
            )
          ).rows.length,
        ).toBe(6);
      });
      await worker.kill();
      await stopWallet();
      // Every outstanding delivery, including one that lost its ACK, is processed after restart.
      await startWallet();
      await publish(channel, userCreated('event-barrier', 'user-barrier'));
      await eventually(async () => {
        expect(
          (
            await ownerDatabase().query(
              'SELECT event_id FROM wallet_consumed_events',
            )
          ).rows.length,
        ).toBe(7);
      });
      expect(
        (
          await ownerDatabase().query(
            'SELECT "userId", balance FROM wallets WHERE "userId" = $1',
            ['user-concurrent'],
          )
        ).rows,
      ).toEqual([{ userId: 'user-concurrent', balance: 91 }]);
      expect(
        await (
          await fetch(`${walletUrl()}/v1/wallets/by-user/user-concurrent`)
        ).json(),
      ).toMatchObject({ userId: 'user-concurrent', balance: 91 });
    });
  }, [() => worker.kill()]);
}, 30_000);

test('an unroutable failure publication does not ACK the source and recovers through real redelivery', async () => {
  await stopWallet();
  const gate = await brokerGate(brokerOptions());
  gate.allow();
  gate.withholdConfirmations();
  await withCleanup(async () => {
    await startWallet({ RABBITMQ_PORT: gate.port });
    await withBroker(async (channel) => {
      await eventually(async () => {
        expect(
          (await channel.checkQueue(destination.queue)).consumerCount,
        ).toBe(1);
      });
      await channel.deleteQueue(destination.failed);
      const body = userCreated('event-returned', 'never-created').replace(
        '"version":1',
        '"version":999',
      );
      await publish(channel, body);
      const queueState = async (name: string): Promise<unknown> => {
        const response = await fetch(
          `${process.env.RABBITMQ_MANAGEMENT_URL ?? ''}/api/queues/${encodeURIComponent(process.env.RABBITMQ_VHOST ?? '')}/${name}`,
          {
            headers: {
              Authorization: `Basic ${Buffer.from(`${process.env.RABBITMQ_USERNAME ?? ''}:${process.env.RABBITMQ_PASSWORD ?? ''}`).toString('base64')}`,
            },
          },
        );
        expect(response.status).toBe(200);
        return response.json();
      };
      // Passive checks on another channel must wait until the consumer recreates its topology.
      await eventually(async () => {
        await queueState(destination.failed);
      });
      await eventually(async () => {
        expect(
          (await channel.checkQueue(destination.failed)).messageCount,
        ).toBe(1);
      });
      // A visible failure copy is not proof of publisher confirmation or source ACK.
      // Observe the pending source before releasing confirms so stale zero metrics cannot pass.
      await eventually(async () => {
        expect(await queueState(destination.queue)).toMatchObject({
          messages: 1,
          messages_unacknowledged: 1,
        });
      });
      gate.releaseConfirmations();
      await eventually(async () => {
        expect(await queueState(destination.queue)).toMatchObject({
          messages: 0,
          messages_unacknowledged: 0,
        });
      });
      await stopWallet();
      const failure = await channel.get(destination.failed, { noAck: false });
      if (!failure) throw new Error('Missing retained delivery');
      expect(failure.content.toString()).toBe(body);
      expect(failure.properties.headers).toMatchObject({
        'wallet-original-redelivered': true,
      });
      channel.ack(failure);
      expect(await channel.get(destination.queue, { noAck: false })).toBe(
        false,
      );
      expect(
        (await ownerDatabase().query('SELECT * FROM wallets')).rows,
      ).toEqual([]);
    });
  }, [() => gate.close()]);
}, 30_000);

test('broker authentication failure logs its diagnostic while HTTP remains available', async () => {
  await stopWallet();
  await startWallet({ RABBITMQ_PASSWORD: 'invalid-test-password' });
  await eventually(() => {
    expect(walletOutput()).toContain('Wallet messaging unavailable');
    expect(walletOutput()).toContain('ACCESS_REFUSED');
    return Promise.resolve();
  }, 2_000);
  expect(
    (await fetch(`${walletUrl()}/v1/wallets/by-user/user-offline`)).status,
  ).toBe(404);
}, 20_000);

test('a database failure preserves oversized envelope identities when AMQP properties are absent', async () => {
  const eventId = 'é'.repeat(128);
  const correlationId = `request-${eventId}`;
  const body = userCreated(eventId, 'user-retry');
  expect(Buffer.byteLength(eventId)).toBeGreaterThan(255);
  expect(Buffer.byteLength(correlationId)).toBeGreaterThan(255);
  await withCleanup(async () => {
    await ownerDatabase().query(
      `ALTER TABLE wallets ADD CONSTRAINT test_reject_wallet CHECK ("userId" <> 'user-retry')`,
    );
    await withBroker(async (channel) => {
      await publish(channel, body);
      await eventually(() => {
        const failures = walletOutput()
          .split('\n')
          .slice(0, -1)
          .filter((line) => line.trim())
          .map((line) =>
            z.record(z.string(), z.unknown()).parse(JSON.parse(line)),
          )
          .filter((record) => record.operation === 'wallet.event.failed');
        expect(failures.length).toBeGreaterThan(0);
        for (const record of failures) {
          expect(record).toMatchObject({
            eventId,
            messageId: eventId,
            correlationId,
          });
          expect(record.error).toHaveProperty(
            'cause.constraint',
            'test_reject_wallet',
          );
        }
        return Promise.resolve();
      }, 2_000);
      expect(
        (await ownerDatabase().query('SELECT * FROM wallets')).rows,
      ).toEqual([]);
      expect(
        (await ownerDatabase().query('SELECT * FROM wallet_consumed_events'))
          .rows,
      ).toEqual([]);
      await ownerDatabase().query(
        'ALTER TABLE wallets DROP CONSTRAINT test_reject_wallet',
      );
      await eventually(async () => {
        expect(
          (
            await ownerDatabase().query(
              'SELECT event_id, correlation_id FROM wallet_consumed_events',
            )
          ).rows,
        ).toEqual([{ event_id: eventId, correlation_id: correlationId }]);
      });
    });
  }, [
    () =>
      withCleanup(stopWallet, [
        () =>
          ownerDatabase().query(
            'ALTER TABLE wallets DROP CONSTRAINT IF EXISTS test_reject_wallet',
          ),
      ]),
  ]);
}, 30_000);

test('a database failure logs its diagnostic and delivery identity, rolls back and retries with backoff', async () => {
  await stopWallet();
  const gate = await brokerGate(brokerOptions());
  gate.allow();
  await withCleanup(async () => {
    await ownerDatabase().query(
      `ALTER TABLE wallets ADD CONSTRAINT test_reject_wallet CHECK ("userId" <> 'user-retry')`,
    );
    await startWallet({ RABBITMQ_PORT: gate.port });
    await withBroker(async (channel) => {
      await publish(channel, userCreated('event-retry', 'user-retry'), {
        messageId: 'delivery-retry',
        correlationId: 'correlation-retry',
      });
      await eventually(() => {
        expect(walletOutput()).toContain('Wallet delivery failed');
        expect(walletOutput()).toContain('test_reject_wallet');
        expect(walletOutput()).toContain('delivery-retry');
        expect(walletOutput()).toContain('correlation-retry');
        return Promise.resolve();
      }, 2_000);
      await eventually(() => {
        expect(gate.attempts()).toBeGreaterThanOrEqual(3);
        return Promise.resolve();
      });
      expect(gate.attempts()).toBeLessThan(6);
      expect(
        (await ownerDatabase().query('SELECT * FROM wallets')).rows,
      ).toEqual([]);
      expect(
        (await ownerDatabase().query('SELECT * FROM wallet_consumed_events'))
          .rows,
      ).toEqual([]);
      await ownerDatabase().query(
        'ALTER TABLE wallets DROP CONSTRAINT test_reject_wallet',
      );
      await eventually(async () => {
        expect(
          await (
            await fetch(`${walletUrl()}/v1/wallets/by-user/user-retry`)
          ).json(),
        ).toMatchObject({ userId: 'user-retry', balance: 0 });
      });
    });
  }, [
    () =>
      withCleanup(stopWallet, [
        () => gate.close(),
        () =>
          ownerDatabase().query(
            'ALTER TABLE wallets DROP CONSTRAINT IF EXISTS test_reject_wallet',
          ),
      ]),
  ]);
}, 30_000);

test('Wallet HTTP and GraphQL start and stay usable during broker loss, with backoff and eventual recovery', async () => {
  await stopWallet();
  const gate = await brokerGate(brokerOptions());
  const absent = async () => {
    expect(
      (await fetch(`${walletUrl()}/v1/wallets/by-user/user-offline`)).status,
    ).toBe(404);
    const response = await fetch(`${walletUrl()}/graphql`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: '{ walletByUser(userId: "user-offline") { id } }',
      }),
    });
    expect(await response.json()).toEqual({ data: { walletByUser: null } });
  };
  await withCleanup(async () => {
    await startWallet({ RABBITMQ_PORT: gate.port });
    await absent();
    const started = Date.now();
    await eventually(() => {
      expect(gate.attempts()).toBeGreaterThanOrEqual(3);
      return Promise.resolve();
    });
    expect(gate.attempts()).toBeLessThan(6);
    expect(Date.now() - started).toBeGreaterThan(200);
    await withBroker(async (channel) => {
      await publish(channel, userCreated('event-recover-1', 'user-recover-1'));
      gate.allow();
      await eventually(async () => {
        expect(
          (await fetch(`${walletUrl()}/v1/wallets/by-user/user-recover-1`))
            .status,
        ).toBe(200);
      });
      const before = gate.attempts();
      gate.block();
      await eventually(() => {
        expect(gate.attempts()).toBeGreaterThan(before);
        return Promise.resolve();
      });
      await absent();
      await publish(channel, userCreated('event-recover-2', 'user-recover-2'));
      gate.allow();
      await eventually(async () => {
        expect(
          (await fetch(`${walletUrl()}/v1/wallets/by-user/user-recover-2`))
            .status,
        ).toBe(200);
      });
    });
  }, [() => withCleanup(stopWallet, [() => gate.close()])]);
}, 30_000);

test.each(['before-commit', 'after-commit'])(
  'consumer death %s leaves the real delivery recoverable and preserves one Wallet',
  async (phase) => {
    await stopWallet();
    const worker = startConsumerWorker(phase);
    await withCleanup(async () => {
      await worker.waitFor('Wallet messaging connected.');
      await withBroker(async (channel) => {
        const body = userCreated('event-crash', 'user-crash');
        await publish(channel, body);
        await worker.waitFor(`CHECKPOINT:${phase}`);
        const committed = phase === 'after-commit';
        expect(
          (await ownerDatabase().query('SELECT * FROM wallet_consumed_events'))
            .rows.length,
        ).toBe(committed ? 1 : 0);
        expect(
          (await ownerDatabase().query('SELECT * FROM wallets')).rows.length,
        ).toBe(committed ? 1 : 0);
        if (committed)
          await ownerDatabase().query('UPDATE wallets SET balance = 37');
        await worker.kill();
        await eventually(async () => {
          const redelivery = await channel.get(destination.queue, {
            noAck: false,
          });
          expect(redelivery).not.toBe(false);
          if (!redelivery) throw new Error('Expected redelivery');
          expect(redelivery.fields.redelivered).toBe(true);
          expect(redelivery.content.toString()).toBe(body);
          channel.nack(redelivery, false, true);
        });
        // The committed event survives restart; an uncommitted transaction leaves neither row.
        await startWallet();
        await publish(
          channel,
          userCreated('event-crash-barrier', 'user-barrier'),
        );
        await eventually(async () => {
          expect(
            (
              await ownerDatabase().query(
                'SELECT * FROM wallet_consumed_events',
              )
            ).rows.length,
          ).toBe(2);
          expect(
            await (
              await fetch(`${walletUrl()}/v1/wallets/by-user/user-crash`)
            ).json(),
          ).toMatchObject({
            userId: 'user-crash',
            balance: committed ? 37 : 0,
          });
        });
        await stopWallet();
        expect(await channel.get(destination.queue, { noAck: false })).toBe(
          false,
        );
        expect(
          (
            await ownerDatabase().query(
              'SELECT * FROM wallets WHERE "userId" = $1',
              ['user-crash'],
            )
          ).rows.length,
        ).toBe(1);
      });
    }, [() => worker.kill()]);
  },
  30_000,
);

test('invalid and unsupported messages are durably retained unchanged and do not loop or mutate Wallets', async () => {
  await withBroker(async (channel) => {
    const invalidUtf8 = Buffer.from(
      userCreated('event-encoding', 'user-encoding'),
    );
    invalidUtf8[invalidUtf8.indexOf('user-encoding')] = 0xff;
    const bodies = [
      Buffer.from('{broken-json'),
      Buffer.from(
        userCreated('unsupported', 'invalid-user').replace(
          '"version":1',
          '"version":99',
        ),
      ),
      Buffer.from(userCreated('event-null', 'bad\u0000user')),
      Buffer.from(userCreated('event-surrogate', 'bad\ud800user')),
      Buffer.from(
        userCreated('event-year-zero', 'user-year-zero').replace(
          '2026-09-30',
          '0000-01-01',
        ),
      ),
      Buffer.from(
        userCreated('event-offset', 'user-offset').replace(
          '12:00:00Z',
          '12:00:00+16:00',
        ),
      ),
      // Raw invalid UTF-8 inside an otherwise valid JSON identity must not become U+FFFD.
      invalidUtf8,
    ];
    for (const body of bodies)
      await publish(channel, body, {
        messageId: 'original-message',
        correlationId: 'transport-correlation',
        expiration: '60000',
        headers: { traceparent: 'original-trace' },
      });
    await eventually(async () => {
      expect((await channel.checkQueue(destination.failed)).messageCount).toBe(
        bodies.length,
      );
    });
    await stopWallet();
    await startWallet();
    await stopWallet();
    const retained: string[] = [];
    for (let i = 0; i < bodies.length; i++) {
      const failure = await channel.get(destination.failed, { noAck: false });
      if (!failure) throw new Error('Missing retained event');
      retained.push(failure.content.toString('base64'));
      expect(failure.properties.deliveryMode).toBe(2);
      expect(failure.properties.messageId).toBe('original-message');
      expect(failure.properties.correlationId).toBe('transport-correlation');
      expect(failure.properties.expiration).toBeUndefined();
      expect(failure.properties.headers).toMatchObject({
        traceparent: 'original-trace',
        'wallet-failure-reason': 'invalid-or-unsupported-user-created',
        'wallet-original-routing-key': 'user.created.v1',
      });
      channel.ack(failure);
    }
    expect(retained.sort()).toEqual(
      bodies.map((body) => body.toString('base64')).sort(),
    );
    expect(await channel.get(destination.queue, { noAck: false })).toBe(false);
    expect((await ownerDatabase().query('SELECT * FROM wallets')).rows).toEqual(
      [],
    );
    expect(
      (await ownerDatabase().query('SELECT * FROM wallet_consumed_events'))
        .rows,
    ).toEqual([]);
  });
}, 30_000);

import { expect, test } from 'bun:test';
import request from 'supertest';
import { sql } from 'slonik';
import {
  getHttpServer,
  getTestDatabase,
  getWalletDatabase,
  user,
  wallet,
} from '@tests/setup/test-server';
import { eventually, eventLogs } from '@tests/setup/operations';
import {
  blockedQuery,
  createProfile,
  walletAvailable,
  withBrokerGate,
  withTableLock,
} from '@tests/setup/shutdown';

test('SIGKILL during Wallet insertion rolls back its deduplication claim and redelivery completes after restart', async () => {
  const pool = getWalletDatabase();
  let id = '';
  await withTableLock(pool, 'wallets', async (release) => {
    id = await createProfile('wallet-before-commit');
    await blockedQuery(pool, 'wallet_runtime', 'INSERT INTO wallets');
    wallet.signal('SIGKILL');
    expect(await wallet.waitForExit()).toEqual({ code: 137, forced: false });
    await release();
    expect(await pool.any(sql.unsafe`SELECT id FROM wallets`)).toEqual([]);
    expect(
      await pool.any(sql.unsafe`SELECT event_id FROM wallet_consumed_events`),
    ).toEqual([]);
  });
  await wallet.start();
  await walletAvailable(id);
  expect(
    await pool.any(sql.unsafe`SELECT event_id FROM wallet_consumed_events`),
  ).toHaveLength(1);
  expect(wallet.output).toContain('"redelivered":true');
}, 45_000);

test('SIGKILL between User insert and outbox commit rolls back both records and permits retry', async () => {
  const pool = getTestDatabase();
  await withTableLock(pool, 'user_outbox', async (release) => {
    const creation = getHttpServer()
      .post('/v1/users')
      .send({
        email: 'interrupted@example.com',
        country: 'England',
        street: 'Baker street',
        postalCode: 'NW16XE',
      })
      .then((response) => response.status);
    await blockedQuery(pool, 'user_runtime', 'INSERT INTO user_outbox');
    user.signal('SIGKILL');
    expect(await user.waitForExit()).toEqual({ code: 137, forced: false });
    expect(user.output).not.toContain('shutdown.completed');
    expect(await creation).toBeGreaterThanOrEqual(500);
    await release();
    expect(await pool.any(sql.unsafe`SELECT id FROM users`)).toEqual([]);
    expect(
      await pool.any(sql.unsafe`SELECT event_id FROM user_outbox`),
    ).toEqual([]);
  });
  await user.start();
  await walletAvailable(await createProfile('interrupted'));
}, 45_000);

test('SIGKILL after broker acceptance leaves uncertain publication pending and restart preserves one Wallet and its balance', async () => {
  await withBrokerGate(user, async (gate) => {
    gate.allow();
    gate.withholdConfirmations();
    await user.start(undefined, { RABBITMQ_PORT: gate.port });
    const id = await createProfile('uncertain-publication');
    await eventually(() => {
      expect(gate.confirmations()).toBeGreaterThan(0);
    });
    await walletAvailable(id);
    await getWalletDatabase().query(
      sql.unsafe`UPDATE wallets SET balance = 73 WHERE "userId" = ${id}`,
    );
    const original = await getTestDatabase().any(
      sql.unsafe`SELECT event_id, envelope FROM user_outbox`,
    );
    user.signal('SIGKILL');
    expect(await user.waitForExit()).toEqual({ code: 137, forced: false });
    expect(
      await getTestDatabase().any(
        sql.unsafe`SELECT published_at FROM user_outbox`,
      ),
    ).toEqual([{ published_at: null }]);
    await user.start();
    await eventually(async () => {
      expect(
        await getTestDatabase().any(
          sql.unsafe`SELECT published_at IS NOT NULL AS completed FROM user_outbox`,
        ),
      ).toEqual([{ completed: true }]);
      expect(
        eventLogs(wallet).filter(
          ({ operation, correlationId }) =>
            operation === 'wallet.event.committed' &&
            correlationId === 'uncertain-publication',
        ),
      ).toHaveLength(2);
    });
    expect(
      await getTestDatabase().any(
        sql.unsafe`SELECT event_id, envelope FROM user_outbox`,
      ),
    ).toEqual(original);
    await walletAvailable(id, 73);
    expect(
      await getWalletDatabase().any(sql.unsafe`SELECT id FROM wallets`),
    ).toHaveLength(1);
    expect(
      await getWalletDatabase().any(
        sql.unsafe`SELECT event_id FROM wallet_consumed_events`,
      ),
    ).toHaveLength(1);
    expect(
      eventLogs(user).some(
        ({ operation, correlationId }) =>
          operation === 'outbox.published' &&
          correlationId === 'uncertain-publication',
      ),
    ).toBe(true);
  });
}, 45_000);

test('SIGKILL after Wallet commit before broker ACK causes correlated redelivery without changing the Wallet or balance', async () => {
  await withBrokerGate(wallet, async (gate) => {
    gate.allow();
    gate.withholdAcknowledgements();
    await wallet.start(undefined, { RABBITMQ_PORT: gate.port });
    await eventually(async () => {
      await request(wallet.url).get('/health/ready/consumer').expect(200);
    });
    const id = await createProfile('commit-before-ack');
    await eventually(() => {
      expect(gate.acknowledgements()).toBe(1);
    });
    await walletAvailable(id);
    await getWalletDatabase().query(
      sql.unsafe`UPDATE wallets SET balance = 91 WHERE "userId" = ${id}`,
    );
    const before = await getWalletDatabase().any(
      sql.unsafe`SELECT * FROM wallets`,
    );
    const committed = eventLogs(wallet).find(
      ({ operation }) => operation === 'wallet.event.committed',
    );
    expect(committed).toBeDefined();
    if (!committed) throw new Error('Missing committed event log');
    wallet.signal('SIGKILL');
    expect(await wallet.waitForExit()).toEqual({ code: 137, forced: false });
    await wallet.start();
    await eventually(() => {
      expect(eventLogs(wallet)).toContainEqual(committed);
      expect(wallet.output).toContain('"redelivered":true');
    });
    await walletAvailable(id, 91);
    expect(
      await getWalletDatabase().any(sql.unsafe`SELECT * FROM wallets`),
    ).toEqual(before);
    expect(
      await getWalletDatabase().any(
        sql.unsafe`SELECT event_id FROM wallet_consumed_events`,
      ),
    ).toHaveLength(1);
  });
}, 45_000);

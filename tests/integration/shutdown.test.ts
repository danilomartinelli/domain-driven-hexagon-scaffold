import { expect, test } from 'bun:test';
import request from 'supertest';
import { sql } from 'slonik';
import { z } from 'zod';
import { eventually, withServiceFault } from '@tests/setup/operations';
import { blockedQuery, withTableLock } from '@tests/setup/shutdown';
import { getHttpServer, getTestDatabase, user } from '@tests/setup/test-server';

const profile = {
  email: 'shutdown@example.com',
  requestId: 'shutdown-request',
  country: 'England',
  street: 'Baker street',
  postalCode: 'NW16XE',
};

test('SIGTERM rejects new work while draining an in-flight User transaction, then restart recovers its Wallet', async () => {
  const pool = getTestDatabase();
  await withTableLock(pool, 'user_outbox', async (release) => {
    const creation = getHttpServer()
      .post('/v1/users')
      .send(profile)
      .then((response) => response);
    await blockedQuery(pool, 'user_runtime', 'INSERT INTO user_outbox');
    const started = Date.now();
    user.signal('SIGTERM');
    // The blocked transaction keeps the drain window open deterministically.
    await eventually(() => {
      expect(user.output).toContain('shutdown.started');
    });
    const ready = await request(user.url).get('/health/ready').expect(503);
    expect(ready.body).toMatchObject({
      lifecycle: 'draining',
      http: { status: 'not_ready' },
      consumer: { status: 'not_ready' },
      publisher: { status: 'not_ready' },
    });
    await request(user.url).get('/health/live').expect(200);
    user.signal('SIGINT'); // A repeated signal must not interrupt the accepted request.
    await getHttpServer()
      .post('/v1/users')
      .send({ ...profile, email: 'rejected@example.com' })
      .expect(503);
    await getHttpServer()
      .post('/user/graphql')
      .send({ query: '{ findUsers(options: "") { count } }' })
      .expect(503);
    await release();
    const response = await creation;
    expect(response.status).toBe(201);
    const { id } = z.object({ id: z.uuid() }).parse(response.body);
    expect(await user.waitForExit()).toEqual({ code: 0, forced: false });
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(user.output).toContain('shutdown.completed');
    expect(
      await pool.any(
        sql.unsafe`SELECT pid FROM pg_stat_activity WHERE usename = 'user_runtime'`,
      ),
    ).toEqual([]);
    await user.start();
    await eventually(async () => {
      const wallet = await getHttpServer()
        .get(`/v1/wallets/by-user/${id}`)
        .expect(200);
      expect(wallet.body).toMatchObject({ userId: id, balance: 0 });
    });
  });
}, 60_000);

test('a stalled dependency exceeds the shutdown bound with failure status and no false completion or partial User', async () => {
  const pool = getTestDatabase();
  await withTableLock(pool, 'user_outbox', async (release) => {
    const creation = getHttpServer()
      .post('/v1/users')
      .send(profile)
      .then((response) => response.status);
    await blockedQuery(pool, 'user_runtime', 'INSERT INTO user_outbox');
    await withServiceFault(
      { service: 'postgres-user', mode: 'unresponsive' },
      async () => {
        const started = Date.now();
        user.signal('SIGTERM');
        await eventually(async () => {
          const response = await request(user.url)
            .get('/health/ready')
            .expect(503);
          expect(response.body).toMatchObject({ lifecycle: 'draining' });
        });
        const failure = await user.stop().then(
          () => undefined,
          (error: unknown) => error,
        );
        expect(failure).toMatchObject({
          message: expect.stringContaining(
            'user exited with code 1',
          ) as unknown,
        });
        expect(Date.now() - started).toBeLessThan(17_000);
        expect(user.output).toContain('shutdown.timed_out');
        expect(user.output).not.toContain('shutdown.completed');
        expect(await creation).toBeGreaterThanOrEqual(500);
      },
    );
    await release();
    await eventually(async () => {
      expect(await pool.any(sql.unsafe`SELECT id FROM users`)).toEqual([]);
      expect(
        await pool.any(sql.unsafe`SELECT event_id FROM user_outbox`),
      ).toEqual([]);
      expect(
        await pool.any(
          sql.unsafe`SELECT pid FROM pg_stat_activity WHERE usename = 'user_runtime'`,
        ),
      ).toEqual([]);
    });
  });
}, 60_000);

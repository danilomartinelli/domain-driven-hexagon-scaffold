import { expect } from 'bun:test';
import { sql, type DatabasePool } from 'slonik';
import { z } from 'zod';
import { withCleanup } from '../../scripts/tests/cleanup';
import { brokerGate } from '../../scripts/tests/broker-gate';
import { eventually } from './operations';
import { getHttpServer } from './test-server';
import type { ServiceProcess } from './service-process';

export async function withTableLock(
  pool: DatabasePool,
  table: string,
  scenario: (release: () => Promise<void>) => Promise<void>,
): Promise<void> {
  const locked = Promise.withResolvers<undefined>();
  const released = Promise.withResolvers<undefined>();
  const transaction = pool.transaction(async (connection) => {
    await connection.query(
      sql.unsafe`LOCK TABLE ${sql.identifier([table])} IN ACCESS EXCLUSIVE MODE`,
    );
    locked.resolve(undefined);
    await released.promise;
  });
  // Surface failure to acquire a lock instead of waiting forever on the barrier.
  void transaction.catch(locked.reject);
  const release = async () => {
    released.resolve(undefined);
    await transaction;
  };
  await withCleanup(async () => {
    await locked.promise;
    await scenario(release);
  }, [release]);
}

export async function blockedQuery(
  pool: DatabasePool,
  role: string,
  fragment: string,
): Promise<void> {
  await eventually(async () => {
    expect(
      await pool.any(sql.unsafe`
      SELECT pid FROM pg_stat_activity WHERE usename = ${role}
      AND wait_event_type = 'Lock' AND query LIKE ${`%${fragment}%`}
    `),
    ).toHaveLength(1);
  });
}

export async function createProfile(correlationId: string): Promise<string> {
  const response = await getHttpServer()
    .post('/v1/users')
    .send({
      email: `${correlationId}@example.com`,
      requestId: correlationId,
      country: 'England',
      street: 'Baker street',
      postalCode: 'NW16XE',
    })
    .expect(201);
  return z.object({ id: z.uuid() }).parse(response.body).id;
}

export async function withBrokerGate(
  service: ServiceProcess,
  scenario: (gate: Awaited<ReturnType<typeof brokerGate>>) => Promise<void>,
): Promise<void> {
  await service.stop();
  const gate = await brokerGate({
    hostname: String(process.env.RABBITMQ_HOST),
    port: Number(process.env.RABBITMQ_PORT),
  });
  await withCleanup(
    () => withCleanup(() => scenario(gate), [() => service.stop()]),
    [() => gate.close()],
  );
}

export async function walletAvailable(id: string, balance = 0): Promise<void> {
  await eventually(async () => {
    const response = await getHttpServer()
      .get(`/v1/wallets/by-user/${id}`)
      .expect(200);
    expect(response.body).toMatchObject({ userId: id, balance });
  });
}

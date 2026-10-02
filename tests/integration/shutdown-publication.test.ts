import { expect, test } from 'bun:test';
import request from 'supertest';
import { sql } from 'slonik';
import { eventually, eventLogs } from '@tests/setup/operations';
import { getTestDatabase, user } from '@tests/setup/test-server';
import {
  createProfile,
  walletAvailable,
  withBrokerGate,
} from '@tests/setup/shutdown';

test('SIGTERM finishes the in-flight publication and leaves newly committed events pending for restart', async () => {
  await withBrokerGate(user, async (gate) => {
    gate.allow();
    gate.withholdConfirmations();
    await user.start(undefined, { RABBITMQ_PORT: gate.port });
    await eventually(async () => {
      await request(user.url).get('/health/ready/publisher').expect(200);
    });
    await createProfile('confirm-drain');
    await eventually(() => {
      expect(gate.confirmations()).toBeGreaterThan(0);
    });
    const pending = await createProfile('next-publication');
    user.signal('SIGTERM');
    await eventually(async () => {
      const response = await request(user.url).get('/health/ready').expect(503);
      expect(response.body).toMatchObject({ lifecycle: 'draining' });
    });
    gate.releaseConfirmations();
    expect(await user.waitForExit()).toEqual({ code: 0, forced: false });
    expect(
      await getTestDatabase().any(sql.unsafe`
      SELECT envelope->>'correlationId' AS correlation, published_at IS NOT NULL AS completed
      FROM user_outbox ORDER BY correlation
    `),
    ).toEqual([
      { correlation: 'confirm-drain', completed: true },
      { correlation: 'next-publication', completed: false },
    ]);
    expect(
      eventLogs(user).filter(
        ({ operation }) => operation === 'outbox.published',
      ),
    ).toHaveLength(1);
    await user.start();
    await walletAvailable(pending);
  });
}, 45_000);

test('SIGTERM with a missing confirmation leaves publication durably pending without logging completion', async () => {
  await withBrokerGate(user, async (gate) => {
    gate.allow();
    gate.withholdConfirmations();
    await user.start(undefined, { RABBITMQ_PORT: gate.port });
    const id = await createProfile('confirmation-timeout');
    await eventually(() => {
      expect(gate.confirmations()).toBeGreaterThan(0);
    });
    user.signal('SIGTERM');
    expect(await user.waitForExit()).toEqual({ code: 0, forced: false });
    expect(
      await getTestDatabase().any(
        sql.unsafe`SELECT published_at FROM user_outbox`,
      ),
    ).toEqual([{ published_at: null }]);
    expect(
      eventLogs(user).some(
        ({ operation, correlationId }) =>
          operation === 'outbox.failed' &&
          correlationId === 'confirmation-timeout',
      ),
    ).toBe(true);
    expect(user.output).not.toContain('outbox.published');
    await user.start();
    await eventually(async () => {
      expect(
        await getTestDatabase().any(
          sql.unsafe`SELECT published_at IS NOT NULL AS completed FROM user_outbox`,
        ),
      ).toEqual([{ completed: true }]);
    });
    await walletAvailable(id);
  });
}, 45_000);

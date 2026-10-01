import { expect, test } from 'bun:test';
import { z } from 'zod';
import { withCleanup } from '../../../../../scripts/tests/cleanup';
import {
  getHttpServer,
  ownerDatabase,
  startUser,
  stopUser,
} from './user-process';

const profile = {
  email: 'pending@example.com',
  country: 'England',
  postalCode: 'NW16XE',
  street: 'Baker street',
};

test('creation persists a versioned pending envelope that survives restart and profile deletion', async () => {
  const created = await getHttpServer()
    .post('/v1/users')
    .send({ ...profile, requestId: 'registration-23' })
    .expect(201);
  const { id } = z.object({ id: z.uuid() }).parse(created.body);
  const pending = await ownerDatabase().query('SELECT * FROM user_outbox');
  expect(pending.rows).toHaveLength(1);
  expect(structuredClone(pending.rows[0])).toMatchObject({
    event_id: expect.any(String) as unknown,
    published_at: null,
    envelope: {
      type: 'user.created',
      version: 1,
      source: 'user',
      eventId: expect.any(String) as unknown,
      occurredAt: expect.any(String) as unknown,
      correlationId: 'registration-23',
      causationId: expect.any(String) as unknown,
      data: { userId: id },
    },
  });
  const row = z
    .object({
      event_id: z.uuid(),
      envelope: z.object({ eventId: z.uuid() }).loose(),
    })
    .parse(pending.rows[0]);
  expect(row.event_id).toBe(row.envelope.eventId);
  expect(Object.keys(row.envelope).sort()).toEqual([
    'causationId',
    'correlationId',
    'data',
    'eventId',
    'occurredAt',
    'source',
    'type',
    'version',
  ]);
  await stopUser();
  await startUser();
  expect(
    (await ownerDatabase().query('SELECT * FROM user_outbox')).rows,
  ).toEqual(pending.rows);
  await getHttpServer().delete(`/v1/users/${id}`).expect(200);
  expect((await ownerDatabase().query('SELECT * FROM users')).rows).toEqual([]);
  expect(
    (await ownerDatabase().query('SELECT * FROM user_outbox')).rows,
  ).toEqual(pending.rows);
}, 30_000);

test('failure after User insert but before outbox insert rolls back both PostgreSQL records', async () => {
  const owner = ownerDatabase();
  await owner.query(`
    CREATE SEQUENCE outbox_failure_probe;
    GRANT USAGE ON SEQUENCE outbox_failure_probe TO user_runtime;
    CREATE FUNCTION fail_pending_creation() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.envelope->'data'->>'userId') THEN
        RAISE EXCEPTION 'Profile was not inserted first';
      END IF;
      PERFORM nextval('outbox_failure_probe');
      RAISE EXCEPTION 'Forced failure after profile persistence';
    END $$;
    CREATE TRIGGER fail_pending_creation BEFORE INSERT ON user_outbox
      FOR EACH ROW EXECUTE FUNCTION fail_pending_creation();
  `);
  await withCleanup(async () => {
    await getHttpServer().post('/v1/users').send(profile).expect(500);
    // Sequence allocation is not transactional: this proves the failure was reached after insertion.
    expect(
      (await owner.query('SELECT is_called FROM outbox_failure_probe')).rows,
    ).toEqual([{ is_called: true }]);
    expect((await owner.query('SELECT * FROM users')).rows).toEqual([]);
    expect((await owner.query('SELECT * FROM user_outbox')).rows).toEqual([]);
  }, [
    () =>
      owner.query(
        'DROP TRIGGER fail_pending_creation ON user_outbox; DROP FUNCTION fail_pending_creation(); DROP SEQUENCE outbox_failure_probe;',
      ),
  ]);
  await getHttpServer().post('/v1/users').send(profile).expect(201);
  expect((await owner.query('SELECT * FROM user_outbox')).rows).toHaveLength(1);
});

test('a duplicate profile leaves exactly the original pending envelope', async () => {
  await getHttpServer().post('/v1/users').send(profile).expect(201);
  const original = await ownerDatabase().query('SELECT * FROM user_outbox');
  await getHttpServer().post('/v1/users').send(profile).expect(409);
  expect(
    (await ownerDatabase().query('SELECT * FROM users')).rows,
  ).toHaveLength(1);
  expect(
    (await ownerDatabase().query('SELECT * FROM user_outbox')).rows,
  ).toEqual(original.rows);
});

test('arbitrary request metadata preserves profile creation and records a valid correlation fallback', async () => {
  await getHttpServer()
    .post('/v1/users')
    .send({ ...profile, requestId: 'x'.repeat(256) })
    .expect(201);
  const { rows } = await ownerDatabase().query(
    'SELECT envelope FROM user_outbox',
  );
  expect(rows).toHaveLength(1);
  const { envelope } = z
    .object({
      envelope: z.object({ correlationId: z.uuid(), causationId: z.uuid() }),
    })
    .parse(rows[0]);
  expect(envelope.correlationId).toBe(envelope.causationId);
});

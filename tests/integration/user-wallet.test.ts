import { expect, test } from 'bun:test';
import { sql } from 'slonik';
import { z } from 'zod';
import {
  getHttpServer,
  getTestDatabase,
  getWalletDatabase,
  user,
  wallet,
} from '@tests/setup/test-server';
import { withCleanup } from '../../scripts/tests/cleanup';
import { withServiceFault } from '@tests/setup/operations';

const profile = {
  email: 'atomic@example.com',
  country: 'England',
  street: 'Baker street',
  postalCode: '28566',
};
const walletSchema = z.object({
  id: z.string(),
  userId: z.string(),
  balance: z.number(),
});
async function until(
  condition: () => Promise<boolean> | boolean,
  timeout = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!(await condition())) {
    if (Date.now() > deadline)
      throw new Error(
        `Distributed operation timed out\n${user.output}\n${wallet.output}`,
      );
    await Bun.sleep(50);
  }
}
async function create(email = profile.email): Promise<string> {
  return z.object({ id: z.string() }).parse(
    (
      await getHttpServer()
        .post('/v1/users')
        .send({ ...profile, email })
        .expect(201)
    ).body,
  ).id;
}
async function observe(userId: string): Promise<z.infer<typeof walletSchema>> {
  let result: z.infer<typeof walletSchema> | undefined;
  await until(async () => {
    const response = await getHttpServer()
      .get(`/v1/wallets/by-user/${userId}`)
      .timeout(2_000);
    if (response.status !== 200) return false;
    result = walletSchema.parse(response.body);
    return true;
  });
  if (!result) throw new Error('Missing Wallet');
  expect(result).toMatchObject({ userId, balance: 0 });
  const graphql = await getHttpServer()
    .post('/wallet/graphql')
    .send({
      query: `{ walletByUser(userId: "${userId}") { id userId balance } }`,
    })
    .expect(200);
  expect(graphql.body).toEqual({ data: { walletByUser: result } });
  expect(
    await getWalletDatabase().any(
      sql.unsafe`SELECT id FROM wallets WHERE "userId" = ${userId}`,
    ),
  ).toEqual([{ id: result.id }]);
  return result;
}
async function published(): Promise<boolean> {
  return (
    (
      await getTestDatabase().any(
        sql.unsafe`SELECT event_id FROM user_outbox WHERE published_at IS NULL`,
      )
    ).length === 0
  );
}

async function pending(userId: string): Promise<void> {
  await getHttpServer().get(`/v1/wallets/by-user/${userId}`).expect(404);
  const response = await getHttpServer()
    .post('/wallet/graphql')
    .send({
      query: `{ walletByUser(userId: "${userId}") { id userId balance } }`,
    })
    .expect(200);
  expect(response.body).toEqual({ data: { walletByUser: null } });
}

async function listedUserIds(): Promise<string[]> {
  const response = await getHttpServer().get('/v1/users').expect(200);
  return z
    .object({ data: z.array(z.object({ id: z.string() })) })
    .parse(response.body)
    .data.map((profile) => profile.id);
}

test('REST creation eventually yields one zero-balance Wallet through both APIs; deletion retains it', async () => {
  const id = await create();
  const before = await observe(id);
  await getHttpServer().delete(`/v1/users/${id}`).expect(200);
  expect(await listedUserIds()).not.toContain(id);
  expect(await observe(id)).toEqual(before);
}, 30_000);

test('multibyte REST correlation metadata preserves Wallet creation and does not block later registrations', async () => {
  const correlations = ['é'.repeat(128), 'later-safe-correlation'];
  const ids: string[] = [];
  for (const [index, requestId] of correlations.entries()) {
    const response = await getHttpServer()
      .post('/v1/users')
      .send({
        ...profile,
        email: `unicode-${String(index)}@example.com`,
        requestId,
      })
      .expect(201);
    ids.push(z.object({ id: z.string() }).parse(response.body).id);
  }
  for (const id of ids) await observe(id);
  await until(published);
  for (const [index, id] of ids.entries()) {
    expect(
      await getTestDatabase().one(sql.type(
        z.object({ correlationId: z.string() }),
      )`
      SELECT envelope->>'correlationId' AS "correlationId" FROM user_outbox
      WHERE envelope->'data'->>'userId' = ${id}
    `),
    ).toEqual({ correlationId: correlations[index] });
  }
}, 30_000);

test('GraphQL creation eventually yields one Wallet with its own independent schema', async () => {
  const response = await getHttpServer()
    .post('/user/graphql')
    .send({
      query: `mutation { create(input: { email: "graphql@example.com", country: "England", street: "Baker street", postalCode: "28566" }) { id } }`,
    })
    .expect(200);
  const body = z
    .object({ data: z.object({ create: z.object({ id: z.string() }) }) })
    .strict()
    .parse(response.body);
  await observe(body.data.create.id);
}, 30_000);

test('Wallet stopped: User creation and broker acceptance succeed; processing completes only after Wallet starts', async () => {
  await wallet.stop();
  const id = await create();
  await until(published);
  expect(
    await getWalletDatabase().any(sql.unsafe`SELECT id FROM wallets`),
  ).toEqual([]);
  await wallet.start();
  await observe(id);
}, 30_000);

test('Wallet persistence failure preserves User and recovers without a partial Wallet or deduplication record', async () => {
  const pool = getWalletDatabase();
  await pool.query(
    sql.unsafe`ALTER TABLE wallets ADD CONSTRAINT reject_wallet CHECK (balance < 0)`,
  );
  let id = '';
  await withCleanup(async () => {
    id = await create();
    await until(() => wallet.output.includes('Wallet delivery failed'));
    expect(
      await getTestDatabase().any(sql.unsafe`SELECT id FROM users`),
    ).toEqual([{ id }]);
    expect(await pool.any(sql.unsafe`SELECT id FROM wallets`)).toEqual([]);
    expect(
      await pool.any(sql.unsafe`SELECT * FROM wallet_consumed_events`),
    ).toEqual([]);
  }, [
    () =>
      pool.query(sql.unsafe`ALTER TABLE wallets DROP CONSTRAINT reject_wallet`),
  ]);
  await observe(id);
}, 30_000);

test('broker stopped: REST and GraphQL creation survive User restart; pending deletion still delivers after broker recovery', async () => {
  let restId = '';
  let graphqlId = '';
  let envelopes: readonly unknown[] = [];
  await withServiceFault(
    { service: 'rabbitmq', mode: 'stopped', allowDataLoss: true },
    async () => {
      await user.stop();
      await user.start();
      restId = await create();
      const response = await getHttpServer()
        .post('/user/graphql')
        .send({
          query: `mutation { create(input: { email: "offline@example.com", country: "England", street: "Baker street", postalCode: "28566" }) { id } }`,
        })
        .expect(200);
      graphqlId = z
        .object({ data: z.object({ create: z.object({ id: z.string() }) }) })
        .parse(response.body).data.create.id;
      envelopes = await getTestDatabase().any(
        sql.unsafe`SELECT event_id, envelope FROM user_outbox ORDER BY event_id`,
      );
      expect(envelopes).toHaveLength(2);
      await pending(restId);
      await pending(graphqlId);
      await getHttpServer().delete(`/v1/users/${restId}`).expect(200);
      expect(await listedUserIds()).toEqual([graphqlId]);
      await pending(restId);
      await user.stop();
      await user.start();
      expect(
        await getTestDatabase().any(
          sql.unsafe`SELECT event_id, envelope FROM user_outbox WHERE published_at IS NULL ORDER BY event_id`,
        ),
      ).toEqual(envelopes);
    },
  );
  await observe(restId);
  await observe(graphqlId);
  expect(await listedUserIds()).toEqual([graphqlId]);
  await until(published);
  expect(
    await getTestDatabase().any(
      sql.unsafe`SELECT event_id, envelope FROM user_outbox ORDER BY event_id`,
    ),
  ).toEqual(envelopes);
  expect(await getTestDatabase().any(sql.unsafe`SELECT id FROM users`)).toEqual(
    [{ id: graphqlId }],
  );
}, 60_000);

test('publication completion failure duplicates delivery with stable identity and one Wallet after restart', async () => {
  const pool = getTestDatabase();
  await pool.query(
    sql.unsafe`CREATE FUNCTION fail_publication() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Completion failed'; END $$`,
  );
  await pool.query(
    sql.unsafe`CREATE TRIGGER fail_publication BEFORE UPDATE ON user_outbox FOR EACH ROW EXECUTE FUNCTION fail_publication()`,
  );
  let id = '';
  let first: z.infer<typeof walletSchema> | undefined;
  await withCleanup(async () => {
    id = await create();
    first = await observe(id);
    await until(() => user.output.includes('publication uncertain'));
    await user.stop();
    expect(await published()).toBe(false);
  }, [
    async () => {
      await pool.query(
        sql.unsafe`DROP TRIGGER fail_publication ON user_outbox`,
      );
      await pool.query(sql.unsafe`DROP FUNCTION fail_publication()`);
    },
  ]);
  await user.start();
  await until(published);
  if (!first) throw new Error('Missing first Wallet');
  expect(await observe(id)).toEqual(first);
  expect(
    await getWalletDatabase().any(
      sql.unsafe`SELECT event_id FROM wallet_consumed_events`,
    ),
  ).toHaveLength(1);
}, 30_000);

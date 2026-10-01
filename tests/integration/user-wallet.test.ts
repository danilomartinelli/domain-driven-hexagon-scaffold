import { expect, test } from 'bun:test';
import { sql } from 'slonik';
import { z } from 'zod';
import { getHttpServer, getTestDatabase } from '@tests/setup/test-server';
import { withCleanup } from '../../scripts/tests/cleanup';

const profile = {
  email: 'atomic@example.com',
  country: 'England',
  street: 'Baker street',
  postalCode: '28566',
};
const walletSchema = z.object({ userId: z.string(), balance: z.number() });

test('REST creation commits a zero-balance Wallet and deletion retains it', async () => {
  const response = await getHttpServer()
    .post('/v1/users')
    .send(profile)
    .expect(201);
  const { id } = z.object({ id: z.string() }).parse(response.body);
  const pool = getTestDatabase();
  const wallets = await pool.any(
    sql.type(walletSchema)`SELECT "userId", balance FROM wallets`,
  );
  expect(wallets).toEqual([{ userId: id, balance: 0 }]);
  await getHttpServer().delete(`/v1/users/${id}`).expect(200);
  expect(
    await pool.any(
      sql.type(walletSchema)`SELECT "userId", balance FROM wallets`,
    ),
  ).toEqual(wallets);
});

test('Wallet persistence failure rolls back User creation and the next request recovers', async () => {
  const pool = getTestDatabase();
  // A real database failure at the second write, not a mock of the listener.
  await pool.query(
    sql.unsafe`ALTER TABLE wallets ADD CONSTRAINT issue16_reject_wallet CHECK (balance < 0)`,
  );
  await withCleanup(async () => {
    await getHttpServer().post('/v1/users').send(profile).expect(500);
    expect(await pool.any(sql.unsafe`SELECT id FROM users`)).toEqual([]);
    expect(await pool.any(sql.unsafe`SELECT id FROM wallets`)).toEqual([]);
  }, [
    () =>
      pool.query(
        sql.unsafe`ALTER TABLE wallets DROP CONSTRAINT issue16_reject_wallet`,
      ),
  ]);
  await getHttpServer().post('/v1/users').send(profile).expect(201);
  expect(await pool.any(sql.unsafe`SELECT id FROM users`)).toHaveLength(1);
  expect(await pool.any(sql.unsafe`SELECT id FROM wallets`)).toHaveLength(1);
});

test('GraphQL creation keeps its response shape and commits a Wallet', async () => {
  const response = await getHttpServer()
    .post('/graphql')
    .send({
      query: `mutation { create(input: { email: "graphql@example.com", country: "England", street: "Baker street", postalCode: "28566" }) { id } }`,
    })
    .expect(200);
  const body = z
    .object({ data: z.object({ create: z.object({ id: z.string() }) }) })
    .strict()
    .parse(response.body);
  expect(
    await getTestDatabase().any(
      sql.type(walletSchema)`SELECT "userId", balance FROM wallets`,
    ),
  ).toEqual([{ userId: body.data.create.id, balance: 0 }]);
});

test('REST duplicate and validation errors retain the adapter-supplied correlation ID', async () => {
  await getHttpServer().post('/v1/users').send(profile).expect(201);
  const duplicate = await getHttpServer()
    .post('/v1/users')
    .send(profile)
    .expect(409);
  expect(duplicate.body).toMatchObject({
    statusCode: 409,
    message: 'User already exists',
  });
  expect(
    z.object({ correlationId: z.string().min(1) }).safeParse(duplicate.body)
      .success,
  ).toBe(true);
  const invalid = await getHttpServer()
    .post('/v1/users')
    .send({ ...profile, email: 'invalid' })
    .expect(400);
  expect(invalid.body).toMatchObject({
    statusCode: 400,
    message: 'Validation error',
  });
  expect(
    z.object({ correlationId: z.string().min(1) }).safeParse(invalid.body)
      .success,
  ).toBe(true);
});

import { expect, test } from 'bun:test';
import { sql } from 'slonik';
import { z } from 'zod';
import { getHttpServer, getTestDatabase } from '@tests/setup/test-server';

const profiles = {
  rue: {
    email: 'rue@example.com',
    country: 'France',
    street: 'Grande Rue',
    postalCode: '28566',
  },
  foch: {
    email: 'foch@example.com',
    country: 'France',
    street: 'Avenue Foch',
    postalCode: '75116',
  },
  baker: {
    email: 'baker@example.com',
    country: 'England',
    street: 'Baker street',
    postalCode: 'NW16XE',
  },
};
type Profile = (typeof profiles)[keyof typeof profiles];

const timestamp = z.iso.datetime();
const restPage = z
  .object({
    count: z.number(),
    limit: z.number(),
    page: z.number(),
    data: z.array(
      z
        .object({
          id: z.string(),
          createdAt: timestamp,
          updatedAt: timestamp,
          email: z.string(),
          country: z.string(),
          postalCode: z.string(),
          street: z.string(),
        })
        .strict(),
    ),
  })
  .strict();
const graphqlPage = z
  .object({
    data: z
      .object({
        findUsers: z
          .object({
            count: z.number(),
            limit: z.number(),
            page: z.number(),
            data: z.array(
              z
                .object({
                  id: z.string(),
                  email: z.string(),
                  country: z.string(),
                  postalCode: z.string(),
                  street: z.string(),
                })
                .strict(),
            ),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();

async function create(profile: Profile): Promise<string> {
  const response = await getHttpServer()
    .post('/v1/users')
    .send(profile)
    .expect(201);
  return z.object({ id: z.string() }).parse(response.body).id;
}

/** Filters travel in the GET body and pagination in the query string. */
async function list(
  filters: Partial<Omit<Profile, 'email'>> = {},
  query = '',
): Promise<z.output<typeof restPage>> {
  const response = await getHttpServer()
    .get(`/v1/users${query}`)
    .send(filters)
    .expect(200);
  return restPage.parse(response.body);
}

function emails(page: { data: readonly { email: string }[] }): string[] {
  return page.data.map((user) => user.email).sort();
}

test('REST listing maps stored profiles without persistence-only fields', async () => {
  const id = await create(profiles.rue);
  await getTestDatabase().query(
    sql.unsafe`UPDATE users SET "createdAt" = '2026-01-02T03:04:05.678Z', "updatedAt" = '2026-02-03T04:05:06.789Z' WHERE id = ${id}`,
  );

  expect(await list()).toEqual({
    count: 1,
    limit: 20,
    page: 0,
    data: [
      {
        id,
        createdAt: '2026-01-02T03:04:05.678Z',
        updatedAt: '2026-02-03T04:05:06.789Z',
        ...profiles.rue,
      },
    ],
  });
});

test('REST body filters match country, street and postal code exactly and combine', async () => {
  await create(profiles.rue);
  await create(profiles.foch);
  await create(profiles.baker);

  expect(emails(await list())).toEqual([
    'baker@example.com',
    'foch@example.com',
    'rue@example.com',
  ]);
  expect(emails(await list({ country: 'France' }))).toEqual([
    'foch@example.com',
    'rue@example.com',
  ]);
  expect(emails(await list({ street: 'Baker street' }))).toEqual([
    'baker@example.com',
  ]);
  expect(emails(await list({ postalCode: '75116' }))).toEqual([
    'foch@example.com',
  ]);
  expect(
    emails(await list({ country: 'France', postalCode: 'NW16XE' })),
  ).toEqual([]);
  expect(await list({ country: 'Fra' })).toMatchObject({ count: 0, data: [] });
  // Blank country and street pass validation and leave the listing unfiltered.
  expect(emails(await list({ country: '', street: '' }))).toEqual([
    'baker@example.com',
    'foch@example.com',
    'rue@example.com',
  ]);
});

test('REST query pagination returns disjoint pages and counts each page', async () => {
  const ids = [
    await create(profiles.rue),
    await create(profiles.foch),
    await create(profiles.baker),
  ];

  const first = await list({}, '?limit=2');
  const second = await list({}, '?limit=2&page=1');
  expect(first).toMatchObject({ count: 2, limit: 2, page: 0 });
  expect(second).toMatchObject({ count: 1, limit: 2, page: 1 });
  expect([...first.data, ...second.data].map((user) => user.id).sort()).toEqual(
    [...ids].sort(),
  );
  expect(await list({}, '?limit=2&page=2')).toMatchObject({
    count: 0,
    limit: 2,
    page: 2,
    data: [],
  });
  expect(await list({ country: 'France' }, '?limit=1&page=1')).toMatchObject({
    count: 1,
    limit: 1,
    page: 1,
  });
  // Existing defaulting: a zero limit falls back to the standard page size.
  expect(await list({}, '?limit=0')).toMatchObject({ count: 3, limit: 20 });
});

test('REST listing still rejects invalid filters and pagination', async () => {
  await create(profiles.rue);
  const invalid = [
    { filters: { country: 'France1' }, query: '' },
    { filters: { street: 'Grande-Rue' }, query: '' },
    { filters: { postalCode: '28-566' }, query: '' },
    { filters: { postalCode: '12345678901' }, query: '' },
    { filters: {}, query: '?limit=-1' },
    { filters: {}, query: '?page=100000' },
    { filters: {}, query: '?page=first' },
  ];
  for (const { filters, query } of invalid) {
    const response = await getHttpServer()
      .get(`/v1/users${query}`)
      .send(filters)
      .expect(400);
    expect(response.body).toMatchObject({
      statusCode: 400,
      message: 'Validation error',
    });
  }
});

test('GraphQL findUsers keeps its unparsed string options and response fields', async () => {
  const rue = await create(profiles.rue);
  const baker = await create(profiles.baker);
  const response = await getHttpServer()
    .post('/user/graphql')
    .send({
      // The educational string argument is not parsed into filters.
      query: `{ findUsers(options: "{\\"country\\":\\"France\\",\\"limit\\":1}") { count limit page data { id email country postalCode street } } }`,
    })
    .expect(200);
  const { findUsers } = graphqlPage.parse(response.body).data;

  expect(findUsers).toMatchObject({ count: 2, limit: 20, page: 0 });
  expect(
    [...findUsers.data].sort((a, b) => a.email.localeCompare(b.email)),
  ).toEqual([
    { id: baker, ...profiles.baker },
    { id: rue, ...profiles.rue },
  ]);
});

test('a returned profile with a stored role outside the User roles fails the listing, as before', async () => {
  const admin = await create(profiles.rue);
  const corrupt = await create(profiles.baker);
  const pool = getTestDatabase();
  await pool.query(
    sql.unsafe`UPDATE users SET role = 'admin' WHERE id = ${admin}`,
  );
  expect(emails(await list())).toEqual([
    'baker@example.com',
    'rue@example.com',
  ]);

  await pool.query(
    sql.unsafe`UPDATE users SET role = 'superuser' WHERE id = ${corrupt}`,
  );
  const rest = await getHttpServer().get('/v1/users').send({}).expect(500);
  expect(rest.body).toMatchObject({
    statusCode: 500,
    message: 'Internal server error',
  });
  const graphql = await getHttpServer()
    .post('/user/graphql')
    .send({ query: '{ findUsers(options: "") { count } }' })
    .expect(200);
  expect(graphql.body).toMatchObject({
    data: null,
    errors: [
      { path: ['findUsers'], extensions: { code: 'INTERNAL_SERVER_ERROR' } },
    ],
  });
  // Only returned rows are validated.
  expect(emails(await list({ country: 'France' }))).toEqual([
    'rue@example.com',
  ]);
});

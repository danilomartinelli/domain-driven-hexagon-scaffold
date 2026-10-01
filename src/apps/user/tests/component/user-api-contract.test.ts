import { expect, test } from 'bun:test';
import { z } from 'zod';
import { getHttpServer } from './user-process';

const profile = {
  email: 'contract@example.com',
  country: 'England',
  postalCode: 'NW16XE',
  street: 'Baker street',
};
const mutation = `mutation Create($input: CreateUserGqlRequestDto!) {
  create(input: $input) { id }
}`;

test('REST preserves creation, duplicate-email conflict and deletion responses', async () => {
  const api = getHttpServer();
  const created = await api.post('/v1/users').send(profile).expect(201);
  const { id } = z.object({ id: z.uuid() }).strict().parse(created.body);
  const duplicate = await api.post('/v1/users').send(profile).expect(409);
  expect(duplicate.body).toMatchObject({ statusCode: 409 });
  await api.delete(`/v1/users/${id}`).expect(200);
  await api.delete(`/v1/users/${id}`).expect(404);
});

test('GraphQL preserves creation, listing and invalid-input responses', async () => {
  const api = getHttpServer();
  const created = await api
    .post('/graphql')
    .send({ query: mutation, variables: { input: profile } })
    .expect(200);
  const {
    data: {
      create: { id },
    },
  } = z
    .object({ data: z.object({ create: z.object({ id: z.uuid() }) }) })
    .strict()
    .parse(created.body);
  const listed = await api
    .post('/graphql')
    .send({
      query:
        '{ findUsers(options: "") { count data { id email country postalCode street } } }',
    })
    .expect(200);
  expect(listed.body).toEqual({
    data: { findUsers: { count: 1, data: [{ id, ...profile }] } },
  });
  const invalid = await api
    .post('/graphql')
    .send({
      query: mutation,
      variables: { input: { ...profile, email: 'invalid' } },
    })
    .expect(200);
  expect(invalid.body).toMatchObject({
    data: null,
    errors: expect.any(Array) as unknown,
  });
});

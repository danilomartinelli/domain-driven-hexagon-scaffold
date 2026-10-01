import { expect, test } from 'bun:test';
import { Paginated } from '@starter/core/domain';
import { FindUsers, FindUsersQuery } from '../../application/find-users';
import type { UserSummary } from '../../application/user-read.port';
import { MemoryUserReads } from './fixtures/memory-user-reads';

function profile(
  n: number,
  address = { country: 'France', street: 'Grande Rue', postalCode: '28566' },
): UserSummary {
  return {
    id: `user-${String(n)}`,
    createdAt: new Date('2026-09-30T12:00:00Z'),
    updatedAt: new Date('2026-09-30T13:00:00Z'),
    email: `user-${String(n)}@example.com`,
    ...address,
  };
}

test('an unfiltered listing returns the first page of twenty profiles without infrastructure', async () => {
  const users = Array.from({ length: 21 }, (_, n) => profile(n));

  const result = await new FindUsers(new MemoryUserReads(users)).execute(
    new FindUsersQuery({}),
  );

  expect(result).toEqual(
    new Paginated({ count: 20, limit: 20, page: 0, data: users.slice(0, 20) }),
  );
});

test('page and limit select the following window and count only its profiles', async () => {
  const users = Array.from({ length: 5 }, (_, n) => profile(n));
  const findUsers = new FindUsers(new MemoryUserReads(users));

  expect(
    await findUsers.execute(new FindUsersQuery({ limit: 2, page: 1 })),
  ).toEqual(
    new Paginated({ count: 2, limit: 2, page: 1, data: users.slice(2, 4) }),
  );
  expect(
    await findUsers.execute(new FindUsersQuery({ limit: 2, page: 2 })),
  ).toEqual(
    new Paginated({ count: 1, limit: 2, page: 2, data: users.slice(4) }),
  );
  expect(
    await findUsers.execute(new FindUsersQuery({ limit: 2, page: 3 })),
  ).toEqual(new Paginated({ count: 0, limit: 2, page: 3, data: [] }));
});

test('country, street and postal code filters reach the read port together, before paging', async () => {
  const rue = profile(1);
  const foch = profile(2, {
    country: 'France',
    street: 'Avenue Foch',
    postalCode: '75116',
  });
  const baker = profile(3, {
    country: 'England',
    street: 'Baker street',
    postalCode: 'NW16XE',
  });
  const findUsers = new FindUsers(new MemoryUserReads([rue, foch, baker]));
  const find = async (props: ConstructorParameters<typeof FindUsersQuery>[0]) =>
    (await findUsers.execute(new FindUsersQuery(props))).data;

  expect(await find({ country: 'France' })).toEqual([rue, foch]);
  expect(await find({ street: 'Baker street' })).toEqual([baker]);
  expect(await find({ postalCode: '75116' })).toEqual([foch]);
  expect(await find({ country: 'France', street: 'Avenue Foch' })).toEqual([
    foch,
  ]);
  expect(await find({ country: 'France', limit: 1, page: 1 })).toEqual([foch]);
});

test('blank filters leave the listing unfiltered', async () => {
  const users = [
    profile(1),
    profile(2, {
      country: 'England',
      street: 'Baker street',
      postalCode: 'NW16XE',
    }),
  ];

  const result = await new FindUsers(new MemoryUserReads(users)).execute(
    new FindUsersQuery({ country: '', postalCode: '', street: '' }),
  );

  expect(result.data).toEqual(users);
});

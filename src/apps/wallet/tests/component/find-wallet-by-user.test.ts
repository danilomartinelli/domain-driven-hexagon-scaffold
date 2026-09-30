import { expect, test } from 'bun:test';
import { z } from 'zod';
import { ownerDatabase, walletUrl } from './wallet-process';

interface StoredWallet {
  id: string;
  userId: string;
  balance: number;
}

const restWallet = z
  .object({ id: z.string(), userId: z.string(), balance: z.number() })
  .strict();
const lookup =
  'query ($userId: ID!) { walletByUser(userId: $userId) { id userId balance } }';

async function store(wallet: StoredWallet): Promise<void> {
  await ownerDatabase().query(
    'INSERT INTO wallets (id, "userId", balance) VALUES ($1, $2, $3)',
    [wallet.id, wallet.userId, wallet.balance],
  );
}

function rest(path: string, method = 'GET'): Promise<Response> {
  return fetch(`${walletUrl()}${path}`, { method });
}

async function graphql(
  query: string,
  variables: Record<string, unknown> = {},
): Promise<unknown> {
  const response = await fetch(`${walletUrl()}/graphql`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  expect(response.status).toBe(200);
  return response.json();
}

test('REST and GraphQL return the same wallet identity, user identity and balance', async () => {
  const wallet = { id: 'wallet-1', userId: 'user-1', balance: 25 };
  await store(wallet);
  await store({ id: 'wallet-2', userId: 'user-2', balance: 0 });

  const response = await rest(`/v1/wallets/by-user/${wallet.userId}`);
  expect(response.status).toBe(200);
  expect(restWallet.parse(await response.json())).toEqual(wallet);
  expect(await graphql(lookup, { userId: wallet.userId })).toEqual({
    data: { walletByUser: wallet },
  });
});

test('a User without a Wallet yields REST 404 and GraphQL null', async () => {
  await store({ id: 'wallet-1', userId: 'user-1', balance: 0 });

  // A Wallet identity is not a User identity.
  for (const userId of ['user-without-wallet', 'wallet-1']) {
    const response = await rest(`/v1/wallets/by-user/${userId}`);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      statusCode: 404,
      message: 'Wallet not found',
      correlationId: expect.any(String) as unknown,
    });
    expect(await graphql(lookup, { userId })).toEqual({
      data: { walletByUser: null },
    });
  }
});

test('Wallet exposes lookups only: no deposit, withdrawal, deletion or cancellation API', async () => {
  const document = z
    .object({ paths: z.record(z.string(), z.record(z.string(), z.unknown())) })
    .parse(await (await rest('/docs-json')).json());
  expect(
    Object.entries(document.paths).map(([path, operations]) => [
      path,
      Object.keys(operations),
    ]),
  ).toEqual([['/v1/wallets/by-user/{userId}', ['get']]]);

  expect(
    await graphql(
      '{ __schema { mutationType { name } subscriptionType { name } queryType { fields { name } } } }',
    ),
  ).toEqual({
    data: {
      __schema: {
        mutationType: null,
        subscriptionType: null,
        queryType: { fields: [{ name: 'walletByUser' }] },
      },
    },
  });
});

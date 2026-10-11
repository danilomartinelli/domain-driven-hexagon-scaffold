import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  discoverApplications,
  environmentPrefix,
  exposedAdapters,
  readApplicationDeclaration,
  runtimeRole,
} from '@starter/capabilities/declaration';

async function withApps(
  declarations: Record<string, unknown>,
  use: (root: string) => void | Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'starter-capabilities-'));
  try {
    for (const [directory, declaration] of Object.entries(declarations)) {
      await mkdir(join(root, directory));
      if (declaration !== undefined)
        await writeFile(
          join(root, directory, 'application.json'),
          typeof declaration === 'string'
            ? declaration
            : JSON.stringify(declaration),
        );
    }
    await use(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('discovery returns every declared application in name order and skips undeclared directories', async () => {
  await withApps(
    {
      scratch: undefined,
      'order-history': {
        name: 'order-history',
        persistence: true,
        messaging: false,
        exposure: false,
      },
      audit: {
        name: 'audit',
        persistence: false,
        messaging: false,
        exposure: false,
      },
    },
    (root) => {
      expect(discoverApplications(root)).toEqual([
        {
          name: 'audit',
          persistence: false,
          messaging: false,
          exposure: false,
        },
        {
          name: 'order-history',
          persistence: true,
          messaging: false,
          exposure: false,
        },
      ]);
      expect(
        readApplicationDeclaration(
          join(root, 'order-history', 'application.json'),
        ),
      ).toMatchObject({ name: 'order-history', persistence: true });
    },
  );
});

test.each([
  [
    'a declaration named after another directory',
    {
      reports: {
        name: 'billing',
        persistence: false,
        messaging: false,
        exposure: false,
      },
    },
    'must declare name "reports"',
  ],
  [
    'an omitted capability',
    { reports: { name: 'reports', persistence: false, messaging: false } },
    'Invalid application declaration',
  ],
  [
    'a non-boolean capability',
    {
      reports: {
        name: 'reports',
        persistence: 'yes',
        messaging: false,
        exposure: false,
      },
    },
    'Invalid application declaration',
  ],
  [
    'an undeclared setting',
    {
      reports: {
        name: 'reports',
        persistence: false,
        messaging: false,
        exposure: false,
        undeclared: [],
      },
    },
    'Invalid application declaration',
  ],
  ['malformed JSON', { reports: '{' }, 'Invalid application declaration'],
])('discovery rejects %s', async (_case, declarations, message) => {
  await withApps(declarations, (root) => {
    expect(() => discoverApplications(root)).toThrow(message);
  });
});

test('business adapters are composed only for declared exposure', () => {
  const declared = (exposure: boolean) => ({
    name: 'reports',
    persistence: false,
    messaging: false,
    exposure,
  });
  expect(exposedAdapters(declared(true), ['rest', 'graphql'])).toEqual([
    'rest',
    'graphql',
  ]);
  expect(exposedAdapters(declared(false), ['rest', 'graphql'])).toEqual([]);
});

test.each([
  ['user', 'USER'],
  ['wallet', 'WALLET'],
  ['order-history', 'ORDER_HISTORY'],
  ['order2-history3', 'ORDER2_HISTORY3'],
])('environment prefix for %s is %s', (name, prefix) => {
  expect(environmentPrefix(name)).toBe(prefix);
});

test.each([
  ['user', 'user_runtime'],
  ['wallet', 'wallet_runtime'],
  ['order-history', 'order_history_runtime'],
  ['order2-history3', 'order2_history3_runtime'],
])('runtime role for %s is %s', (name, role) => {
  expect(runtimeRole(name)).toBe(role);
});

test.each([
  '',
  'Order_History',
  'order_history',
  '1order',
  'order--history',
  'order-',
  '../user',
  'user runtime',
])('application contract names reject invalid application name %j', (name) => {
  expect(() => environmentPrefix(name)).toThrow(
    `Invalid application name: ${name}`,
  );
  expect(() => runtimeRole(name)).toThrow(`Invalid application name: ${name}`);
});

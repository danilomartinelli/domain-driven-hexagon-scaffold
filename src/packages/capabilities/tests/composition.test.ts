import { expect, test } from 'bun:test';
import { composeApplication } from '@starter/capabilities/composition';

test('all registered requirements are checked before any composition factory runs', () => {
  let constructed = false;
  expect(() =>
    composeApplication(
      {
        name: 'reports',
        persistence: false,
        messaging: false,
        exposure: false,
      },
      {
        integrations: ['persistence'],
        groups: [{ name: 'reports', requires: ['persistence'] }],
      },
      {
        integrations: {
          persistence: () => {
            constructed = true;
            return 'database';
          },
        },
        groups: {
          reports: () => {
            constructed = true;
            return 'reports';
          },
        },
      },
    ),
  ).toThrow('reports requires persistence');
  expect(constructed).toBe(false);
});

test('registered exposure groups withdraw their adapters while other groups stay composed', () => {
  const composition = {
    integrations: [],
    groups: [
      { name: 'worker', requires: [] },
      { name: 'api', requires: [], exposure: true as const },
    ],
  };
  const parts = composeApplication(
    { name: 'reports', persistence: false, messaging: false, exposure: false },
    composition,
    {
      integrations: {},
      groups: {
        worker: () => 'worker',
        api: () => {
          throw new Error('Must not construct withdrawn adapters');
        },
      },
    },
  );
  expect(parts).toEqual(['worker']);
});

test('unbound registrations and unregistered factories fail before partial composition', () => {
  let constructed = false;
  const factory = () => {
    constructed = true;
    return 'adapter';
  };
  const bindings: Record<string, () => string>[] = [
    { missing: factory },
    { reports: factory, extra: factory },
  ];
  for (const groups of bindings) {
    expect(() =>
      composeApplication(
        {
          name: 'reports',
          persistence: true,
          messaging: false,
          exposure: false,
        },
        {
          integrations: ['persistence'],
          groups: [{ name: 'reports', requires: ['persistence'] }],
        },
        { integrations: { persistence: factory }, groups },
      ),
    ).toThrow('composition registrations and factories differ');
  }
  expect(constructed).toBe(false);
});

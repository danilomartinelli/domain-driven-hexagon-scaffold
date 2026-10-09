import 'reflect-metadata';
import { rejects } from 'node:assert/strict';
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import {
  Module,
  type DynamicModule,
  type INestApplication,
} from '@nestjs/common';
import {
  composeApplicationModule,
  ApplicationReadiness,
  MESSAGE_HANDLERS,
  type ApplicationPart,
  type ApplicationFactories,
} from '@starter/nest-support/composition';

const directories: string[] = [];
const applications: INestApplication[] = [];
afterEach(async () => {
  await Promise.all(applications.splice(0).map((app) => app.close()));
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

async function start(module: DynamicModule) {
  const app = await NestFactory.create(module, {
    logger: false,
    abortOnError: false,
  });
  applications.push(app);
  await app.listen(0, '127.0.0.1');
  return { app, url: await app.getUrl() };
}

function declaration(
  capabilities: Partial<
    Record<'persistence' | 'messaging' | 'exposure', boolean>
  > = {},
  registrations?: {
    integrations: string[];
    groups: { name: string; requires: string[]; exposure?: true }[];
  },
) {
  const directory = mkdtempSync(join(tmpdir(), 'application-composition-'));
  directories.push(directory);
  writeFileSync(
    join(directory, 'application.json'),
    JSON.stringify({
      name: 'reports',
      persistence: false,
      messaging: false,
      exposure: false,
      ...capabilities,
    }),
  );
  writeFileSync(
    join(directory, 'composition.json'),
    JSON.stringify(
      registrations ?? {
        integrations: Object.keys(capabilities).filter(
          (key) => capabilities[key as keyof typeof capabilities],
        ),
        groups: [],
      },
    ),
  );
  return directory;
}

test('an all-disabled application serves health with no dependency or backlog', async () => {
  const module = await composeApplicationModule(declaration(), {
    integrations: {},
    groups: {},
  });
  const { url } = await start(module);
  const ready = await fetch(`${url}/health/ready`);
  expect(ready.status).toBe(200);
  expect(await ready.json()).toEqual({
    service: 'reports',
    lifecycle: 'running',
    http: { status: 'ready' },
    database: { status: 'not_applicable' },
    consumer: { status: 'not_applicable' },
    publisher: { status: 'not_applicable' },
  });
  const backlog = await fetch(`${url}/health/backlog`);
  expect(backlog.status).toBe(200);
  expect(await backlog.json()).toEqual({
    service: 'reports',
    status: 'not_applicable',
  });
  const live = await fetch(`${url}/health/live`);
  expect(live.status).toBe(200);
  expect(await live.json()).toEqual({ service: 'reports', status: 'alive' });
});

test('the persistence probe gates HTTP readiness and recovers after the cached failure', async () => {
  let available = false;
  const module = await composeApplicationModule(
    declaration({ persistence: true }),
    {
      integrations: {
        persistence: () => ({
          database: {
            useFactory: () => () =>
              available
                ? Promise.resolve()
                : Promise.reject(new Error('database unavailable')),
          },
        }),
      },
      groups: {},
    },
  );
  const { url } = await start(module);
  const ready = await fetch(`${url}/health/ready`);
  expect(ready.status).toBe(503);
  expect(await ready.json()).toEqual({
    service: 'reports',
    lifecycle: 'running',
    http: { status: 'not_ready' },
    database: { status: 'not_ready' },
    consumer: { status: 'not_applicable' },
    publisher: { status: 'not_applicable' },
  });
  available = true;
  expect((await fetch(`${url}/health/ready/http`)).status).toBe(503);
  await Bun.sleep(1_050);
  const recovered = await fetch(`${url}/health/ready/database`);
  expect(recovered.status).toBe(200);
  expect(await recovered.json()).toEqual({
    service: 'reports',
    status: 'ready',
  });
});

test('registered messaging roles start in order, report their state and drain in parallel on close', async () => {
  const calls: string[] = [];
  const stopped = Promise.withResolvers<undefined>();
  const consumer = {
    start: () => {
      calls.push('consumer.start');
    },
    stop: async () => {
      calls.push('consumer.stop');
      await stopped.promise;
    },
    snapshot: () => ({
      connected: false,
      failures: 2,
      retries: 1,
      retryDelayMs: 250,
      lastFailureAt: null,
    }),
  };
  const publisher = {
    start: () => {
      calls.push('publisher.start');
    },
    stop: () => {
      calls.push('publisher.stop');
      stopped.resolve(undefined);
      return Promise.resolve();
    },
    snapshot: () => ({
      connected: true,
      failures: 0,
      retries: 0,
      retryDelayMs: 0,
      lastFailureAt: null,
    }),
  };
  const module = await composeApplicationModule(
    declaration({ messaging: true }),
    {
      integrations: {
        messaging: () => ({
          providers: [
            { provide: 'consumer', useValue: consumer },
            { provide: 'publisher', useValue: publisher },
          ],
          consumer: 'consumer',
          publisher: 'publisher',
        }),
      },
      groups: {},
    },
  );
  expect(calls).toEqual([]);
  const { app, url } = await start(module);
  expect(calls).toEqual(['consumer.start', 'publisher.start']);
  const ready = await fetch(`${url}/health/ready`);
  expect(ready.status).toBe(503);
  expect(await ready.json()).toMatchObject({
    http: { status: 'ready' },
    database: { status: 'not_applicable' },
    consumer: {
      status: 'not_ready',
      reason: 'messaging_unavailable',
      failures: 2,
      retries: 1,
      retryDelayMs: 250,
    },
    publisher: { status: 'ready', reason: null },
  });
  const backlog = await fetch(`${url}/health/backlog`);
  expect(await backlog.json()).toEqual({
    service: 'reports',
    status: 'not_applicable',
  });
  await app.close();
  await app.close();
  applications.splice(applications.indexOf(app), 1);
  expect(calls).toEqual([
    'consumer.start',
    'publisher.start',
    'consumer.stop',
    'publisher.stop',
  ]);
});

test('a publisher reports its backlog and an unavailable database gates both messaging roles', async () => {
  const role = {
    start: () => undefined,
    stop: () => Promise.resolve(),
    snapshot: () => ({
      connected: true,
      failures: 0,
      retries: 0,
      retryDelayMs: 0,
      lastFailureAt: null,
    }),
  };
  let backlogAvailable = true;
  const module = await composeApplicationModule(
    declaration({ persistence: true, messaging: true }),
    {
      integrations: {
        persistence: () => ({
          database: {
            useFactory: () => () => Promise.reject(new Error('unavailable')),
          },
        }),
        messaging: () => ({
          providers: [
            { provide: 'consumer', useValue: role },
            { provide: 'publisher', useValue: role },
          ],
          consumer: 'consumer',
          publisher: 'publisher',
          backlog: {
            useFactory: () => () =>
              backlogAvailable
                ? Promise.resolve({ pendingCount: 3, oldestAgeSeconds: 12 })
                : Promise.reject(new Error('unavailable')),
          },
        }),
      },
      groups: {},
    },
  );
  const { url } = await start(module);
  expect(await (await fetch(`${url}/health/ready`)).json()).toMatchObject({
    http: { status: 'not_ready' },
    database: { status: 'not_ready' },
    consumer: { status: 'not_ready', reason: 'database_unavailable' },
    publisher: { status: 'not_ready', reason: 'database_unavailable' },
  });
  const backlog = await fetch(`${url}/health/backlog`);
  expect(backlog.status).toBe(200);
  expect(await backlog.json()).toEqual({
    service: 'reports',
    status: 'available',
    pendingCount: 3,
    oldestAgeSeconds: 12,
  });
  backlogAvailable = false;
  await Bun.sleep(1_050);
  const unavailable = await fetch(`${url}/health/backlog`);
  expect(unavailable.status).toBe(503);
  expect(await unavailable.json()).toEqual({
    service: 'reports',
    status: 'unavailable',
  });
});

test.each([
  [
    'duplicate consumer',
    { consumer: 'role' },
    { consumer: 'role' },
    true,
    'at most one consumer',
  ],
  [
    'duplicate publisher',
    { publisher: 'role' },
    { publisher: 'role' },
    true,
    'at most one publisher',
  ],
  [
    'missing role',
    {},
    {},
    true,
    'messaging role exactly when messaging is enabled',
  ],
  [
    'disabled messaging',
    { consumer: 'role' },
    {},
    false,
    'messaging role exactly when messaging is enabled',
  ],
  [
    'backlog without publisher',
    {
      consumer: 'role',
      backlog: {
        useFactory: () => () =>
          Promise.resolve({ pendingCount: 0, oldestAgeSeconds: null }),
      },
    },
    {},
    true,
    'backlog requires a publisher',
  ],
] satisfies [string, ApplicationPart, ApplicationPart, boolean, string][])(
  '%s is rejected before any provider is instantiated',
  async (_name, first, second, messaging, message) => {
    let instantiated = false;
    const provider = {
      provide: 'role',
      useFactory: () => {
        instantiated = true;
        throw new Error('must not instantiate');
      },
    };
    const directory = declaration(
      { messaging },
      {
        integrations: ['messaging'],
        groups: [{ name: 'delivery', requires: [] }],
      },
    );
    await rejects(
      composeApplicationModule(directory, {
        integrations: {
          messaging: () => ({ providers: [provider], ...first }),
        },
        groups: {
          delivery: () => ({
            providers: [provider],
            ...(messaging ? second : first),
          }),
        },
      }),
      new RegExp(message),
    );
    expect(instantiated).toBe(false);
  },
);

test('an integration consumer receives group handlers and a parent provider reads readiness', async () => {
  const handler = { handle: () => 'accepted' };
  let handled: string | undefined;
  const module = await composeApplicationModule(
    declaration(
      { messaging: true },
      {
        integrations: ['messaging'],
        groups: [{ name: 'reports', requires: ['messaging'] }],
      },
    ),
    {
      integrations: {
        messaging: () =>
          Promise.resolve({
            providers: [
              {
                provide: 'consumer',
                inject: [MESSAGE_HANDLERS],
                useFactory: (handlers: (typeof handler)[]) => ({
                  start: () => {
                    handled = handlers.map((entry) => entry.handle()).join(',');
                  },
                  stop: () => Promise.resolve(),
                  snapshot: () => ({
                    connected: true,
                    failures: 0,
                    retries: 0,
                    retryDelayMs: 0,
                    lastFailureAt: null,
                  }),
                }),
              },
            ],
            consumer: 'consumer',
          }),
      },
      groups: {
        reports: () => ({
          providers: [{ provide: 'handler', useValue: handler }],
          handlers: ['handler'],
        }),
      },
    },
  );
  @Module({
    imports: [module],
    providers: [
      {
        provide: 'reporter',
        inject: [ApplicationReadiness],
        useFactory: (readiness: ApplicationReadiness) => ({
          read: () => readiness.snapshot(),
        }),
      },
    ],
  })
  // eslint-disable-next-line @typescript-eslint/no-extraneous-class -- Nest requires a module class.
  class Root {}
  const app = await NestFactory.create(Root, {
    logger: false,
    abortOnError: false,
  });
  applications.push(app);
  await app.init();
  expect(handled).toBe('accepted');
  const reporter = app.get<{ read: ApplicationReadiness['snapshot'] }>(
    'reporter',
  );
  expect(await reporter.read()).toMatchObject({
    http: { status: 'ready' },
    consumer: { status: 'ready' },
  });
});

test('async integrations finish before groups and composition uses the initially checked files', async () => {
  const directory = declaration(
    { exposure: true },
    {
      integrations: ['exposure'],
      groups: [{ name: 'reports', requires: [] }],
    },
  );
  const calls: string[] = [];
  await composeApplicationModule(directory, {
    integrations: {
      exposure: async () => {
        calls.push('integration.started');
        writeFileSync(
          join(directory, 'application.json'),
          'invalid after preflight',
        );
        writeFileSync(
          join(directory, 'composition.json'),
          'invalid after preflight',
        );
        await Bun.sleep(1);
        calls.push('integration.completed');
        return {};
      },
    },
    groups: {
      reports: () => {
        calls.push('group');
        return {};
      },
    },
  });
  expect(calls).toEqual([
    'integration.started',
    'integration.completed',
    'group',
  ]);
});

test('a withdrawn exposure group contributes no providers, roles, handlers or backlog', async () => {
  let composed = false;
  await composeApplicationModule(
    declaration(
      {},
      {
        integrations: [],
        groups: [{ name: 'api', requires: ['messaging'], exposure: true }],
      },
    ),
    {
      integrations: {},
      groups: {
        api: () => {
          composed = true;
          throw new Error('must not compose');
        },
      },
    },
  );
  expect(composed).toBe(false);
});

test.each(['incompatible', 'unbound'])(
  '%s registrations fail before any factory runs',
  async (kind) => {
    let composed = false;
    const factory = () => {
      composed = true;
      return {};
    };
    const directory = declaration(
      {},
      {
        integrations: ['exposure'],
        groups: [
          {
            name: 'reports',
            requires: kind === 'incompatible' ? ['persistence'] : [],
          },
        ],
      },
    );
    await rejects(
      composeApplicationModule(directory, {
        integrations: { exposure: factory },
        groups: kind === 'unbound' ? { extra: factory } : { reports: factory },
      }),
      new RegExp(
        kind === 'incompatible'
          ? 'reports requires persistence'
          : 'registrations and factories differ',
      ),
    );
    expect(composed).toBe(false);
  },
);

test('an untyped persistence factory cannot omit its database probe', async () => {
  const factories = JSON.parse(
    '{"integrations":{},"groups":{}}',
  ) as ApplicationFactories;
  // Model a JavaScript author; the compile-only fixture pins the typed contract.
  Object.assign(factories.integrations, { persistence: () => ({}) });
  await rejects(
    composeApplicationModule(declaration({ persistence: true }), factories),
    /persistence integration must supply a database probe/,
  );
});

test.each(['consumer', 'publisher'] as const)(
  'a lone %s leaves the other role not applicable',
  async (roleName) => {
    const role = {
      start: () => undefined,
      stop: () => Promise.resolve(),
      snapshot: () => ({
        connected: true,
        failures: 0,
        retries: 0,
        retryDelayMs: 0,
        lastFailureAt: null,
      }),
    };
    const module = await composeApplicationModule(
      declaration({ messaging: true }),
      {
        integrations: {
          messaging: () => ({
            providers: [{ provide: 'role', useValue: role }],
            [roleName]: 'role',
          }),
        },
        groups: {},
      },
    );
    const { url } = await start(module);
    const other = roleName === 'consumer' ? 'publisher' : 'consumer';
    const ready = await fetch(`${url}/health/ready`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({
      [other]: { status: 'not_applicable' },
      [roleName]: { status: 'ready' },
    });
    expect((await fetch(`${url}/health/ready/unknown`)).status).toBe(404);
  },
);

test('a messaging role must name a provider declared by its own part', async () => {
  await rejects(
    composeApplicationModule(declaration({ messaging: true }), {
      integrations: { messaging: () => ({ consumer: 'missing-consumer' }) },
      groups: {},
    }),
    /consumer must name a provider declared by its part/,
  );
});

test('programmatic close makes cached readiness and backlog unavailable while a role drains', async () => {
  const draining = Promise.withResolvers<undefined>();
  const drained = Promise.withResolvers<undefined>();
  const publisher = {
    start: () => undefined,
    stop: () => {
      draining.resolve(undefined);
      return drained.promise;
    },
    snapshot: () => ({
      connected: true,
      failures: 0,
      retries: 0,
      retryDelayMs: 0,
      lastFailureAt: null,
    }),
  };
  const module = await composeApplicationModule(
    declaration({ persistence: true, messaging: true }),
    {
      integrations: {
        persistence: () => ({
          database: { useFactory: () => () => Promise.resolve() },
        }),
        messaging: () => ({
          providers: [{ provide: 'publisher', useValue: publisher }],
          publisher: 'publisher',
          backlog: {
            useFactory: () => () =>
              Promise.resolve({ pendingCount: 2, oldestAgeSeconds: 4 }),
          },
        }),
      },
      groups: {},
    },
  );
  const { app, url } = await start(module);
  expect((await fetch(`${url}/health/ready`)).status).toBe(200);
  expect((await fetch(`${url}/health/backlog`)).status).toBe(200);
  const closing = app.close();
  try {
    await draining.promise;
    const readiness = await fetch(`${url}/health/ready`);
    expect(readiness.status).toBe(503);
    expect(await readiness.json()).toMatchObject({
      lifecycle: 'draining',
      http: { status: 'not_ready' },
      database: { status: 'not_ready' },
      publisher: { status: 'not_ready', reason: 'draining' },
      consumer: { status: 'not_applicable' },
    });
    const backlog = await fetch(`${url}/health/backlog`);
    expect(backlog.status).toBe(503);
    expect(await backlog.json()).toEqual({
      service: 'reports',
      status: 'unavailable',
    });
    expect((await fetch(`${url}/health/live`)).status).toBe(200);
  } finally {
    drained.resolve(undefined);
    await closing;
  }
});

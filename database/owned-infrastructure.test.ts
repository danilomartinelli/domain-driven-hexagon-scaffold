import { expect, test } from 'bun:test';
import type { ApplicationDeclaration } from '@starter/capabilities/declaration';
import type { EnvironmentManifest } from './environment';
import {
  newIdentities,
  preparedInfrastructure,
  installationInfrastructure,
  requiredServices,
  processSettings,
} from './owned-infrastructure';

test('new development identities preserve hyphenated application names', () => {
  expect(
    newIdentities('development', 'ddh-dev-fixture', 'order-history'),
  ).toEqual({
    application: 'order-history',
    applicationService: 'app-order-history',
    database: {
      service: 'postgres-order-history',
      volume: 'order-history-postgres',
      database: 'ddh_dev_fixture_order-history',
      owner: 'starter',
      runtime: 'order_history_runtime',
      secrets: [],
    },
    broker: {
      service: 'rabbitmq',
      volume: 'rabbitmq',
      vhost: 'ddh-dev-fixture',
      username: 'starter',
      secrets: [],
    },
    gateway: { service: 'gateway', name: 'ddh-dev-fixture-gateway' },
  });
});

const combinations = [
  { persistence: false, messaging: false, exposure: false },
  { persistence: false, messaging: false, exposure: true },
  { persistence: false, messaging: true, exposure: false },
  { persistence: false, messaging: true, exposure: true },
  { persistence: true, messaging: false, exposure: false },
  { persistence: true, messaging: false, exposure: true },
  { persistence: true, messaging: true, exposure: false },
  { persistence: true, messaging: true, exposure: true },
];

function prepared(
  kind: 'development' | 'test',
  app: ApplicationDeclaration,
): EnvironmentManifest {
  return {
    environment: kind,
    project: 'ddh-dev-fixture',
    run: 'fixture',
    owner: '00000000-0000-4000-8000-000000000094',
    status: 'ready',
    topology: [app],
    applicationPorts: { 'order-history': 3100 },
    // Inventory deliberately survives capability disablement.
    databases: [
      {
        app: 'order-history',
        prefix: 'ORDER_HISTORY_DB',
        host: '127.0.0.1',
        port: 15432,
        database: 'ddh_dev_fixture_order-history',
        username: 'fixture-owner',
        password: 'owner-secret',
        runtime: {
          username: 'order_history_runtime',
          password: 'runtime-secret',
        },
      },
    ],
    broker: {
      port: 15672,
      managementPort: 25672,
      username: 'fixture user',
      password: 'broker/secret',
      vhost: 'ddh-dev-fixture',
    },
    gateway: {
      name: 'ddh-dev-fixture-gateway',
      host: 'host.docker.internal',
      proxyPort: 18000,
      adminPort: 18001,
    },
  };
}

const preparedDatabase = {
  ORDER_HISTORY_DB_HOST: '127.0.0.1',
  ORDER_HISTORY_DB_PORT: '15432',
  ORDER_HISTORY_DB_USERNAME: 'order_history_runtime',
  ORDER_HISTORY_DB_PASSWORD: 'runtime-secret',
  ORDER_HISTORY_DB_NAME: 'ddh_dev_fixture_order-history',
};
const preparedOwner = {
  ORDER_HISTORY_DB_MIGRATION_USERNAME: 'fixture-owner',
  ORDER_HISTORY_DB_MIGRATION_PASSWORD: 'owner-secret',
};
const preparedBroker = {
  RABBITMQ_HOST: '127.0.0.1',
  RABBITMQ_PORT: '15672',
  RABBITMQ_USERNAME: 'fixture user',
  RABBITMQ_PASSWORD: 'broker/secret',
  RABBITMQ_VHOST: 'ddh-dev-fixture',
  ORDER_HISTORY_RABBITMQ_URL:
    'amqp://fixture%20user:broker%2Fsecret@127.0.0.1:15672/ddh-dev-fixture',
  RABBITMQ_MANAGEMENT_URL: 'http://127.0.0.1:25672',
};
const containerBroker = {
  RABBITMQ_HOST: 'rabbitmq',
  RABBITMQ_PORT: '5672',
  RABBITMQ_USERNAME: 'fixture user',
  RABBITMQ_PASSWORD: 'broker/secret',
  RABBITMQ_VHOST: 'ddh-dev-fixture',
  ORDER_HISTORY_RABBITMQ_URL:
    'amqp://fixture%20user:broker%2Fsecret@rabbitmq:5672/ddh-dev-fixture',
};
const installationDatabase = {
  ORDER_HISTORY_DB_HOST: 'postgres-order-history',
  ORDER_HISTORY_DB_PORT: '5432',
  ORDER_HISTORY_DB_NAME: 'order_history',
  ORDER_HISTORY_DB_USERNAME: 'order_history_runtime',
  ORDER_HISTORY_DB_PASSWORD_FILE: '/run/secrets/order-history-runtime-password',
};
const installationOwner = {
  DATABASE_APP: 'order-history',
  ORDER_HISTORY_DB_HOST: 'postgres-order-history',
  ORDER_HISTORY_DB_PORT: '5432',
  ORDER_HISTORY_DB_NAME: 'order_history',
  ORDER_HISTORY_DB_MIGRATION_USERNAME: 'order_history_owner',
  ORDER_HISTORY_DB_MIGRATION_PASSWORD_FILE:
    '/run/secrets/order-history-owner-password',
};
const installationBroker = {
  RABBITMQ_HOST: 'rabbitmq',
  RABBITMQ_PORT: '5672',
  RABBITMQ_USERNAME: 'scaffold',
  RABBITMQ_PASSWORD_FILE: '/run/secrets/broker-password',
  RABBITMQ_VHOST: 'fixture-installation',
};

for (const capabilities of combinations) {
  const app: ApplicationDeclaration = {
    name: 'order-history',
    ...capabilities,
  };
  for (const kind of ['development', 'test', 'installation'] as const) {
    const infrastructure =
      kind === 'installation'
        ? installationInfrastructure({
            project: 'fixture-installation',
            applied: { applications: [{ declaration: app }] },
          })
        : preparedInfrastructure(prepared(kind, app));
    test(`required services for ${kind} ${JSON.stringify(capabilities)}`, () => {
      expect(Object.fromEntries(requiredServices(infrastructure))).toEqual({
        ...(kind !== 'test' && { 'app-order-history': 'application' }),
        ...(app.persistence && { 'postgres-order-history': 'database' }),
        ...(app.messaging && { rabbitmq: 'broker' }),
        ...(app.exposure && { gateway: 'gateway' }),
      });
    });
    for (const vantage of ['host', 'container'] as const) {
      for (const process of ['runtime', 'migration'] as const) {
        test(`${kind} ${vantage} ${process} ${JSON.stringify(capabilities)}`, () => {
          if (kind === 'installation' && vantage === 'host') {
            expect(() =>
              processSettings(infrastructure, app.name, process, vantage),
            ).toThrow('Installations have no host vantage');
            return;
          }
          const expected =
            kind === 'installation'
              ? {
                  NODE_ENV: 'production',
                  ...(process === 'migration' && {
                    DATABASE_APP: 'order-history',
                  }),
                  ...(process === 'runtime' && {
                    ORDER_HISTORY_HTTP_PORT: '3000',
                  }),
                  ...(app.persistence &&
                    (process === 'runtime'
                      ? installationDatabase
                      : installationOwner)),
                  ...(app.messaging &&
                    process === 'runtime' &&
                    installationBroker),
                }
              : {
                  ORDER_HISTORY_HTTP_PORT: '3100',
                  ...(app.persistence && {
                    ...preparedDatabase,
                    ...(vantage === 'container' && {
                      ORDER_HISTORY_DB_HOST: 'postgres-order-history',
                      ORDER_HISTORY_DB_PORT: '5432',
                    }),
                    ...(process === 'migration' && preparedOwner),
                  }),
                  ...(app.messaging &&
                    (vantage === 'host' ? preparedBroker : containerBroker)),
                  ...(app.exposure &&
                    vantage === 'host' && {
                      GATEWAY_NAME: 'ddh-dev-fixture-gateway',
                      GATEWAY_HOST: 'host.docker.internal',
                      GATEWAY_PROXY_PORT: '18000',
                      GATEWAY_ADMIN_PORT: '18001',
                    }),
                };
          expect(
            processSettings(infrastructure, app.name, process, vantage),
          ).toEqual(expected);
        });
      }
    }
  }
}

for (const kind of ['test', 'installation'] as const) {
  test(`new ${kind} identities preserve existing naming`, () => {
    expect(newIdentities(kind, 'fixture-project', 'order-history')).toEqual(
      kind === 'test'
        ? {
            application: 'order-history',
            applicationService: 'app-order-history',
            database: {
              service: 'postgres-order-history',
              database: 'fixture_project_order-history',
              owner: 'starter',
              runtime: 'order_history_runtime',
              secrets: [],
            },
            broker: {
              service: 'rabbitmq',
              vhost: 'fixture-project',
              username: 'starter',
              secrets: [],
            },
            gateway: { service: 'gateway', name: 'fixture-project-gateway' },
          }
        : {
            application: 'order-history',
            applicationService: 'app-order-history',
            database: {
              service: 'postgres-order-history',
              volume: 'postgres-order-history',
              database: 'order_history',
              owner: 'order_history_owner',
              runtime: 'order_history_runtime',
              secrets: [
                'order-history-admin-password',
                'order-history-owner-password',
                'order-history-runtime-password',
              ],
            },
            broker: {
              service: 'rabbitmq',
              volume: 'rabbitmq',
              vhost: 'fixture-project',
              username: 'scaffold',
              secrets: ['broker-password'],
            },
            gateway: { service: 'gateway', name: 'fixture-project-gateway' },
          },
    );
  });
}

for (const process of ['runtime', 'migration'] as const) {
  test(`explicit ${process} overrides win over container coordinates without exposing management`, () => {
    const infrastructure = preparedInfrastructure(
      prepared('development', {
        name: 'order-history',
        persistence: true,
        messaging: true,
        exposure: true,
      }),
    );
    const overrides = {
      ORDER_HISTORY_DB_HOST: 'external-db',
      ORDER_HISTORY_DB_PORT: '5544',
      ORDER_HISTORY_RABBITMQ_URL: 'amqp://explicit',
      RABBITMQ_HOST: 'external-broker',
      RABBITMQ_PORT: '5679',
      RABBITMQ_MANAGEMENT_URL: 'http://host-only',
      ORDER_HISTORY_CUSTOM: '$custom',
    };
    const settings = processSettings(
      infrastructure,
      'order-history',
      process,
      'container',
      overrides,
    );
    expect(settings).toMatchObject({
      ORDER_HISTORY_DB_HOST: 'external-db',
      ORDER_HISTORY_DB_PORT: '5544',
      ORDER_HISTORY_RABBITMQ_URL: 'amqp://explicit',
      RABBITMQ_HOST: 'external-broker',
      RABBITMQ_PORT: '5679',
      ORDER_HISTORY_CUSTOM: '$custom',
    });
    expect(settings).not.toHaveProperty('RABBITMQ_MANAGEMENT_URL');
    expect(overrides).toHaveProperty(
      'RABBITMQ_MANAGEMENT_URL',
      'http://host-only',
    );
  });
}

test('secret files preserve credential authority and never become an encoded broker URL', () => {
  const infrastructure = preparedInfrastructure(
    prepared('test', {
      name: 'order-history',
      persistence: true,
      messaging: true,
      exposure: false,
    }),
  );
  infrastructure.databases[0].owner.password = { file: '/owner-password' };
  const runtime = infrastructure.databases[0].runtime;
  const broker = infrastructure.broker;
  if (!runtime || !broker) throw new Error('Missing fixture credentials');
  runtime.password = { file: '/runtime-password' };
  broker.password = { file: '/broker-password' };
  expect(
    processSettings(infrastructure, 'order-history', 'migration', 'container'),
  ).toEqual({
    ORDER_HISTORY_HTTP_PORT: '3100',
    ORDER_HISTORY_DB_HOST: 'postgres-order-history',
    ORDER_HISTORY_DB_PORT: '5432',
    ORDER_HISTORY_DB_USERNAME: 'order_history_runtime',
    ORDER_HISTORY_DB_PASSWORD_FILE: '/runtime-password',
    ORDER_HISTORY_DB_NAME: 'ddh_dev_fixture_order-history',
    ORDER_HISTORY_DB_MIGRATION_USERNAME: 'fixture-owner',
    ORDER_HISTORY_DB_MIGRATION_PASSWORD_FILE: '/owner-password',
    RABBITMQ_HOST: 'rabbitmq',
    RABBITMQ_PORT: '5672',
    RABBITMQ_USERNAME: 'fixture user',
    RABBITMQ_PASSWORD_FILE: '/broker-password',
    RABBITMQ_VHOST: 'ddh-dev-fixture',
  });
});

test('legacy development storage stays active and exposes only its DB settings', () => {
  const manifest = prepared('development', {
    name: 'order-history',
    persistence: false,
    messaging: false,
    exposure: false,
  });
  manifest.databases.push({
    app: 'legacy',
    prefix: 'DB',
    host: '127.0.0.1',
    port: 15433,
    database: 'ddh_dev_fixture_legacy',
    username: 'legacy-owner',
    password: 'legacy-secret',
  });
  const infrastructure = preparedInfrastructure(manifest);
  expect(Object.fromEntries(requiredServices(infrastructure))).toEqual({
    'app-order-history': 'application',
    'postgres-legacy': 'database',
  });
  expect(
    processSettings(infrastructure, 'legacy', 'migration', 'host'),
  ).toEqual({
    DB_HOST: '127.0.0.1',
    DB_PORT: '15433',
    DB_USERNAME: 'legacy-owner',
    DB_PASSWORD: 'legacy-secret',
    DB_NAME: 'ddh_dev_fixture_legacy',
  });
  expect(
    processSettings(infrastructure, 'legacy', 'runtime', 'container'),
  ).toEqual({
    DB_HOST: 'postgres-legacy',
    DB_PORT: '5432',
    DB_USERNAME: 'legacy-owner',
    DB_PASSWORD: 'legacy-secret',
    DB_NAME: 'ddh_dev_fixture_legacy',
  });
  expect(requiredServices({ ...infrastructure, kind: 'test' }).size).toBe(0);
});

test('explicit secret-file paths replace generated file paths', () => {
  const infrastructure = installationInfrastructure({
    project: 'fixture-installation',
    applied: {
      applications: [
        {
          declaration: {
            name: 'order-history',
            persistence: true,
            messaging: true,
            exposure: false,
          },
        },
      ],
    },
  });
  const settings = processSettings(
    infrastructure,
    'order-history',
    'runtime',
    'container',
    {
      ORDER_HISTORY_DB_PASSWORD_FILE: '/explicit-runtime',
      RABBITMQ_PASSWORD_FILE: '/explicit-broker',
    },
  );
  expect(settings).toMatchObject({
    ORDER_HISTORY_DB_PASSWORD_FILE: '/explicit-runtime',
    RABBITMQ_PASSWORD_FILE: '/explicit-broker',
  });
  expect(settings).not.toHaveProperty('ORDER_HISTORY_DB_PASSWORD');
  expect(settings).not.toHaveProperty('RABBITMQ_PASSWORD');
});

test('required services include resources that preparation has not allocated yet', () => {
  const manifest = prepared('test', {
    name: 'order-history',
    persistence: true,
    messaging: true,
    exposure: true,
  });
  manifest.databases = [];
  delete manifest.broker;
  delete manifest.gateway;
  expect(
    Object.fromEntries(requiredServices(preparedInfrastructure(manifest))),
  ).toEqual({
    'postgres-order-history': 'database',
    rabbitmq: 'broker',
    gateway: 'gateway',
  });
});

for (const process of ['runtime', 'migration'] as const) {
  test(`explicit ${process} file overrides preserve generated values for caller validation`, () => {
    const infrastructure = preparedInfrastructure(
      prepared('development', {
        name: 'order-history',
        persistence: true,
        messaging: true,
        exposure: false,
      }),
    );
    expect(
      processSettings(infrastructure, 'order-history', process, 'container', {
        ORDER_HISTORY_DB_PASSWORD_FILE: '/explicit-runtime',
        RABBITMQ_PASSWORD_FILE: '/explicit-broker',
      }),
    ).toMatchObject({
      ORDER_HISTORY_DB_PASSWORD: 'runtime-secret',
      ORDER_HISTORY_DB_PASSWORD_FILE: '/explicit-runtime',
      RABBITMQ_PASSWORD: 'broker/secret',
      RABBITMQ_PASSWORD_FILE: '/explicit-broker',
    });
  });
}

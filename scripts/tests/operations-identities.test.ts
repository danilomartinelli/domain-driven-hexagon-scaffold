import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { operationsCompose } from '../lib/operations-compose';
import { stateSchema, type InstallationState } from '../lib/operations-config';
import { dockerInstallationRuntime } from '../lib/operations-docker-runtime';
import { deploymentPlan } from '../lib/operations-plan';
import { artifact, installationState } from './installation-runtime-fixture';

const unexpected = (args: string[]) =>
  Promise.reject(new Error(`Unexpected command: ${args.join(' ')}`));

/** An inventory whose recorded names differ from what its declarations derive today. */
function renamedInventory(
  directory: string,
  applied = [artifact('user', 'b', true, true)],
): InstallationState {
  const state = installationState(directory, applied);
  state.retained = {
    databases: ['user', 'wallet'].map((application) => ({
      application,
      service: `retained-${application}`,
      volume: `owned_retained-${application}-volume`,
      database: `retained_${application}`,
      roles: [`retained_${application}_owner`, `${application}_runtime`],
      secrets: ['admin', 'owner', 'runtime'].map(
        (authority) => `retained-${application}-${authority}`,
      ),
    })),
    broker: {
      service: 'retained-broker',
      volume: 'owned_retained-broker-volume',
      vhost: 'retained-vhost',
      username: 'retained-user',
      secrets: ['retained-broker-password'],
    },
  };
  return state;
}

function recordingRuntime(current: InstallationState) {
  const commands: string[][] = [];
  const runtime = dockerInstallationRuntime({
    current,
    compose: (args) => {
      commands.push(args);
      // The archive copy is the only command whose effect the operation reads back.
      if (args[0] === 'cp') writeFileSync(args[2], 'archive');
      return Promise.resolve('');
    },
    execute: unexpected,
    oneShot: (service, command) => unexpected([service, ...command]),
  });
  return { commands, runtime };
}

test('a retained entry, not the declaration, determines the addressed database service', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ddh-identities-'));
  try {
    const state = renamedInventory(directory);
    const { commands, runtime } = recordingRuntime(state);
    await runtime.startDatabase('user');
    await runtime.provisionDatabase('user');
    await runtime.startBroker();
    await runtime.backup(
      state.applied.applications[0],
      join(directory, 'user.dump'),
    );
    const [start, provision, broker, dump, copy, remove] = commands;
    expect(commands).toHaveLength(6);
    expect(start).toEqual([
      'up',
      '-d',
      '--wait',
      '--wait-timeout',
      '60',
      'retained-user',
    ]);
    expect(broker).toEqual([
      'up',
      '-d',
      '--wait',
      '--wait-timeout',
      '60',
      'retained-broker',
    ]);
    for (const command of [provision, dump, remove])
      expect(command.slice(0, 3)).toEqual(['exec', '-T', 'retained-user']);
    expect(copy[1]).toStartWith('retained-user:/tmp/');
    const provisioning = provision[5];
    for (const statement of [
      'PGDATABASE=retained_user',
      'cat /run/secrets/retained-user-admin',
      'cat /run/secrets/retained-user-owner',
      'cat /run/secrets/retained-user-runtime',
      "CREATE ROLE retained_user_owner LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD %L', :'owner_password') WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'retained_user_owner')",
      'GRANT CONNECT ON DATABASE "retained_user" TO retained_user_owner, user_runtime;',
    ])
      expect(provisioning).toContain(statement);
    expect(dump[5]).toStartWith(
      'export PGHOST=127.0.0.1 PGDATABASE=retained_user PGUSER=retained_user_owner; export PGPASSWORD="$(cat /run/secrets/retained-user-owner)";',
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('rendered installation services use their retained identities', () => {
  const compose = operationsCompose(renamedInventory('/fixture'), false) as {
    services: Record<string, Record<string, unknown>>;
    volumes: Record<string, unknown>;
    secrets: Record<string, unknown>;
  };
  expect(Object.keys(compose.services).sort()).toEqual([
    'app-user',
    'migrate-user',
    'retained-broker',
    'retained-user',
  ]);
  expect(Object.keys(compose.volumes).sort()).toEqual([
    'retained-broker-volume',
    'retained-user-volume',
  ]);
  expect(compose.services['retained-user']).toMatchObject({
    environment: {
      POSTGRES_DB: 'retained_user',
      POSTGRES_PASSWORD_FILE: '/run/secrets/retained-user-admin',
    },
    volumes: ['retained-user-volume:/var/lib/postgresql'],
  });
  expect(compose.services['retained-broker']).toMatchObject({
    secrets: ['retained-broker-password'],
    environment: {
      RABBITMQ_DEFAULT_USER: 'retained-user',
      RABBITMQ_DEFAULT_VHOST: 'retained-vhost',
    },
    volumes: ['retained-broker-volume:/var/lib/rabbitmq'],
  });
  expect(compose.services['migrate-user']).toMatchObject({
    environment: {
      USER_DB_HOST: 'retained-user',
      USER_DB_NAME: 'retained_user',
      USER_DB_MIGRATION_USERNAME: 'retained_user_owner',
      USER_DB_MIGRATION_PASSWORD_FILE: '/run/secrets/retained-user-owner',
    },
    secrets: ['retained-user-owner'],
  });
  expect(compose.services['app-user']).toMatchObject({
    environment: {
      RABBITMQ_HOST: 'retained-broker',
      RABBITMQ_USERNAME: 'retained-user',
      RABBITMQ_VHOST: 'retained-vhost',
    },
    secrets: ['retained-user-runtime', 'retained-broker-password'],
  });
});

for (const secrets of [[], ['broker-password', 'extra-password']])
  for (const active of [true, false])
    test(`installation rendering refuses ${String(secrets.length)} retained broker secrets while ${active ? 'active' : 'inactive'}`, () => {
      const state = renamedInventory(
        '/fixture',
        active ? [artifact('user', 'b', true, true)] : [],
      );
      const parsed = stateSchema.parse({
        ...state,
        retained: {
          ...state.retained,
          broker: { ...state.retained.broker, secrets },
        },
      });
      expect(() => {
        operationsCompose(parsed, false);
      }).toThrow('Invalid retained broker identity');
    });

test('a removed application keeps its retained database addressable for reactivation', async () => {
  const state = renamedInventory('/fixture');
  const { commands, runtime } = recordingRuntime(state);
  await runtime.startDatabase('wallet');
  expect(commands).toEqual([
    ['up', '-d', '--wait', '--wait-timeout', '60', 'retained-wallet'],
  ]);
  const wallet = artifact('wallet', 'c', true, true);
  const plan = deploymentPlan({
    state,
    existing: true,
    desired: {
      applications: [
        { ...state.applied.applications[0], migrations: [] },
        { ...wallet, migrations: [] },
      ],
    },
    histories: {},
    secretFiles: [],
  });
  expect(plan.services.add).toEqual(['app-wallet', 'retained-wallet']);
  expect(plan.resources.provision).toEqual([]);
  expect(plan.resources.retain).toContainEqual({
    kind: 'database',
    application: 'wallet',
    volume: 'owned_retained-wallet-volume',
    before: 'inactive',
    after: 'active',
  });
  expect(plan.resources.missingSecrets).toContain('retained-wallet-owner');
  expect(
    Object.keys(
      (
        operationsCompose(
          {
            ...state,
            applied: { applications: [...state.applied.applications, wallet] },
          },
          false,
        ) as { services: Record<string, unknown> }
      ).services,
    ),
  ).toContain('retained-wallet');
});

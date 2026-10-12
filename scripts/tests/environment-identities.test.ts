import { expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { environmentLocation } from '../../database/environment';
import { selectedApplications } from '../../database/topology';
import { operateEnvironment } from '../lib/environments';
import { withProcesses, withShell } from './environment-renderer-fixture';

/**
 * A development manifest written before service and volume names were recorded.
 * Wallet's database stays retained after its application was excluded;
 * `database/environment.test.ts` reads the same shape without the runner.
 */
function olderManifest(run: string) {
  const { project } = environmentLocation('development', run);
  const database = (app: string, port: number) => ({
    app,
    prefix: `${app.toUpperCase()}_DB`,
    host: '127.0.0.1',
    port,
    username: 'starter',
    password: `${app}-owner-secret`,
    database: `${project.replaceAll('-', '_')}_${app}`,
    runtime: { username: `${app}_runtime`, password: `${app}-runtime-secret` },
  });
  return {
    environment: 'development',
    run,
    project,
    owner: randomUUID(),
    status: 'ready',
    apps: ['user'],
    topology: selectedApplications(['user']),
    applicationPorts: { user: 41001 },
    databases: [database('user', 41002), database('wallet', 41003)],
    broker: {
      port: 41004,
      managementPort: 41005,
      username: 'starter',
      password: 'broker-secret',
      vhost: project,
    },
    gateway: {
      name: `${project}-gateway`,
      host: 'host.docker.internal',
      proxyPort: 41006,
      adminPort: 41007,
    },
  };
}

/** Run one environment action against an older manifest, observing only process boundaries. */
async function withOlderManifest(
  action: 'inspect' | 'down' | 'prepare',
  check: (observed: {
    recorded: ReturnType<typeof olderManifest>;
    before: string;
    after: string;
    commands: string[][];
    compose: () => {
      services: Record<string, { volumes?: string[] }>;
      volumes: Record<string, unknown>;
    };
    messages: string[];
  }) => void,
  apps?: string[],
) {
  const run = `fixture-${randomUUID().slice(0, 8)}`;
  const location = environmentLocation('development', run);
  const recorded = olderManifest(run);
  const before = JSON.stringify(recorded, null, 2);
  const commands: string[][] = [];
  const messages: string[] = [];
  const output = spyOn(console, 'log').mockImplementation((message) => {
    messages.push(String(message));
  });
  try {
    mkdirSync(location.directory, { recursive: true });
    writeFileSync(location.manifestPath, before, { mode: 0o600 });
    const code = await withShell({}, () =>
      withProcesses(
        (command) => {
          commands.push(command);
          return {};
        },
        () => operateEnvironment(action, 'development', run, [], apps),
      ),
    );
    expect(code).toBe(0);
    check({
      recorded,
      before,
      after: readFileSync(location.manifestPath, 'utf8'),
      commands,
      compose: () =>
        JSON.parse(
          readFileSync(join(location.directory, 'compose.json'), 'utf8'),
        ) as ReturnType<Parameters<typeof check>[0]['compose']>,
      messages,
    });
  } finally {
    output.mockRestore();
    rmSync(location.directory, { recursive: true, force: true });
  }
}

const composeCommands = (commands: string[][], subcommand: string) =>
  commands.filter(
    (command) => command[1] === 'compose' && command.includes(subcommand),
  );

/** Services a Compose subcommand addressed, without its options. */
const composeServices = (commands: string[][], subcommand: string) =>
  composeCommands(commands, subcommand)
    .flatMap((command) => command.slice(command.indexOf(subcommand) + 1))
    .filter((argument) => !/^(-|\d+$)/.test(argument))
    .sort();

/** The existing development naming: `postgres-<app>` services and `<app>-postgres` volumes. */
function expectExistingNames(compose: {
  services: Record<string, { volumes?: string[] }>;
  volumes: Record<string, unknown>;
}) {
  expect(Object.keys(compose.services).sort()).toEqual([
    'app-user',
    'gateway',
    'postgres-user',
    'postgres-wallet',
    'rabbitmq',
  ]);
  expect(Object.keys(compose.volumes).sort()).toEqual([
    'rabbitmq',
    'user-postgres',
    'wallet-postgres',
  ]);
  expect(compose.services['postgres-user'].volumes).toEqual([
    'user-postgres:/var/lib/postgresql',
  ]);
  expect(compose.services['postgres-wallet'].volumes).toEqual([
    'wallet-postgres:/var/lib/postgresql',
  ]);
  expect(compose.services.rabbitmq.volumes).toEqual([
    'rabbitmq:/var/lib/rabbitmq',
  ]);
}

test('an older development manifest is inspected without being written', () =>
  withOlderManifest('inspect', ({ recorded, before, after, messages }) => {
    expect(after).toBe(before);
    const summary = messages.find((message) =>
      message.startsWith('{"project":'),
    );
    expect(JSON.parse(summary ?? 'null')).toMatchObject({
      databases: [
        {
          app: 'user',
          service: 'postgres-user',
          volume: `${recorded.project}_user-postgres`,
          active: true,
        },
        {
          app: 'wallet',
          service: 'postgres-wallet',
          volume: `${recorded.project}_wallet-postgres`,
          active: false,
        },
      ],
      broker: { volume: `${recorded.project}_rabbitmq`, active: true },
    });
  }));

test('an older development manifest stops without preparation and keeps every name', () =>
  withOlderManifest('down', ({ recorded, after, commands, compose }) => {
    expect(composeCommands(commands, 'up')).toEqual([]);
    expect(
      commands.some((command) =>
        command.includes('scripts/reconcile-databases.ts'),
      ),
    ).toBe(false);
    expect(composeCommands(commands, 'down')).toHaveLength(1);
    expectExistingNames(compose());
    expect(JSON.parse(after)).toMatchObject({
      ...recorded,
      status: 'stopped',
    });
  }));

test('preparing an older development manifest keeps its names, databases, credentials and queued work', () =>
  withOlderManifest('prepare', ({ recorded, after, commands, compose }) => {
    expectExistingNames(compose());
    expect(composeServices(commands, 'up')).toEqual([
      'gateway',
      'postgres-user',
      'rabbitmq',
    ]);
    expect(composeServices(commands, 'stop')).toEqual(['postgres-wallet']);
    expect(JSON.parse(after)).toMatchObject({
      ...recorded,
      status: 'ready',
    });
  }));

test('reactivating an excluded application reuses its retained database', () =>
  withOlderManifest(
    'prepare',
    ({ recorded, after, commands, compose }) => {
      expect(composeServices(commands, 'up')).toEqual([
        'gateway',
        'postgres-user',
        'postgres-wallet',
        'rabbitmq',
      ]);
      expect(composeServices(commands, 'stop')).toEqual([]);
      expect(compose().services['postgres-wallet'].volumes).toEqual([
        'wallet-postgres:/var/lib/postgresql',
      ]);
      expect(JSON.parse(after)).toMatchObject({
        databases: recorded.databases,
        broker: recorded.broker,
      });
    },
    ['user', 'wallet'],
  ));

test('preparing an older development manifest records the names it was provisioned with', () =>
  withOlderManifest('prepare', ({ after }) => {
    const prepared = JSON.parse(after) as {
      databases: { app: string; service?: string; volume?: string }[];
      broker?: { volume?: string };
    };
    expect(
      prepared.databases.map(({ app, service, volume }) => ({
        app,
        service,
        volume,
      })),
    ).toEqual([
      { app: 'user', service: 'postgres-user', volume: 'user-postgres' },
      { app: 'wallet', service: 'postgres-wallet', volume: 'wallet-postgres' },
    ]);
    expect(prepared.broker?.volume).toBe('rabbitmq');
  }));

import { parseReadinessSnapshot } from '@starter/capabilities/readiness';
import { expect, test } from 'bun:test';
import { connect } from 'amqplib';
import { randomUUID } from 'node:crypto';
import {
  cp,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { z } from 'zod';
import { runCommand } from '../lib/command';
import { availablePort } from '../lib/environments';
import {
  appWorkspace,
  expectRendered,
  generate,
  replaceOnce,
  run,
} from './app-generator-fixture';
import { until, withApp } from './app-runtime-fixture';
import { brokerGate } from './broker-gate';
import { withCleanup } from './cleanup';
import { composeProbeConfiguration } from './compose-fixture';
import { removeOwnedContainer } from './owned-container';
import { tcpGate } from './tcp-gate';

interface Combination {
  name: string;
  persistence: boolean;
  messaging: boolean;
  exposure: boolean;
}

const combinations: Combination[] = [false, true].flatMap((persistence) =>
  [false, true].flatMap((messaging) =>
    [false, true].map((exposure) => ({
      name: `cap-${persistence ? 'p' : 'x'}${messaging ? 'm' : 'x'}${exposure ? 'e' : 'x'}`,
      persistence,
      messaging,
      exposure,
    })),
  ),
);

// Expected naming conventions, stated independently of the implementation.
const identifier = (name: string) => name.replaceAll('-', '_');
const prefix = (name: string) => identifier(name).toUpperCase();
const role = (name: string) => `${identifier(name)}_runtime`;

/** The database settings an application reads with its environment prefix. */
function databaseSettings(
  name: string,
  target: {
    port: string;
    database: string;
    username: string;
    password: string;
    credential?: '' | 'MIGRATION_';
  },
): Record<string, string> {
  const variable = (suffix: string) => `${prefix(name)}_DB_${suffix}`;
  const credential = target.credential ?? '';
  return {
    [variable('HOST')]: '127.0.0.1',
    [variable('PORT')]: target.port,
    [variable('NAME')]: target.database,
    [variable(`${credential}USERNAME`)]: target.username,
    [variable(`${credential}PASSWORD`)]: target.password,
  };
}

/**
 * Test-owned behavior that exercises each enabled capability. It is added after
 * the generated skeleton passed its project checks and never becomes product output.
 */
async function addProbes(app: string, combination: Combination) {
  const { persistence, messaging, exposure } = combination;
  const imports: string[] = [];
  const providers: string[] = [];
  if (persistence) {
    await writeFile(
      join(app, 'database/migrations/1790900000000_probe-records.sql'),
      `-- Up Migration
CREATE TABLE probe_records (id text PRIMARY KEY, source text NOT NULL);
GRANT SELECT, INSERT ON probe_records TO ${role(combination.name)};

-- Down Migration
DROP TABLE probe_records;
`,
    );
    await writeFile(
      join(app, 'database/probe-store.ts'),
      `import { Inject, type OnApplicationBootstrap } from '@nestjs/common';
      import { sql, type DatabasePool } from 'slonik';
      import { DATABASE_POOL } from './database.module';
      export class ProbeStore implements OnApplicationBootstrap {
        constructor(@Inject(DATABASE_POOL) private readonly pool: DatabasePool) {}
        async onApplicationBootstrap(): Promise<void> { await this.record('startup', 'bootstrap'); }
        async record(id: string, source: string): Promise<void> {
          await this.pool.query(sql.unsafe\`INSERT INTO probe_records (id, source) VALUES (\${id}, \${source}) ON CONFLICT (id) DO NOTHING\`);
        }
        async find(id: string): Promise<unknown> {
          return this.pool.maybeOneFirst(sql.unsafe\`SELECT source FROM probe_records WHERE id = \${id}\`);
        }
      }`,
    );
    imports.push("import { ProbeStore } from '../database/probe-store';");
    providers.push('ProbeStore');
  }
  if (messaging) {
    await writeFile(
      join(app, 'adapters/probe.handler.ts'),
      `import type { MessageHandler, MessageMetadata } from '../application/message-handler';
      export class ProbeHandler implements MessageHandler {
        readonly pattern = 'probe.v1';
        constructor(private readonly store?: { record(id: string, source: string): Promise<void> }) {}
        async handle(_data: unknown, metadata: MessageMetadata): Promise<undefined> {
          await this.store?.record(metadata.eventId, 'message');
          return undefined;
        }
      }`,
    );
    imports.push("import { ProbeHandler } from '../adapters/probe.handler';");
    providers.push(
      persistence
        ? '{ provide: ProbeHandler, inject: [ProbeStore], useFactory: (store: ProbeStore) => new ProbeHandler(store) }'
        : '{ provide: ProbeHandler, useFactory: () => new ProbeHandler() }',
    );
  }
  if (exposure) {
    await writeFile(
      join(app, 'adapters/probe.controller.ts'),
      `import { Controller, Get, Inject, Param } from '@nestjs/common';
      ${persistence ? "import { ProbeStore } from '../database/probe-store';" : ''}
      @Controller('probe')
      export class ProbeController {
        ${persistence ? 'constructor(@Inject(ProbeStore) private readonly store: ProbeStore) {}' : ''}
        @Get(':id') async read(@Param('id') id: string): Promise<unknown> {
          return { id, source: ${persistence ? 'await this.store.find(id)' : "'unpersisted'"} };
        }
      }`,
    );
    imports.push(
      "import { ProbeController } from '../adapters/probe.controller';",
    );
  }
  const module = join(app, 'composition/app.module.ts');
  const requires = [
    ...(persistence ? ['persistence'] : []),
    ...(messaging ? ['messaging'] : []),
  ];
  const registration = join(app, 'composition.json');
  const composition = JSON.parse(await readFile(registration, 'utf8')) as {
    integrations: string[];
    groups: unknown[];
  };
  composition.groups.push({ name: 'probe', requires });
  await writeFile(registration, JSON.stringify(composition));
  const source = replaceOnce(
    await readFile(module, 'utf8'),
    'const functionality: Record<string, () => Functionality> = {};',
    `const functionality: Record<string, () => Functionality> = { probe: () => ({ providers: [${providers.join(', ')}], ${messaging ? 'handlers: [ProbeHandler],' : ''} ${exposure ? 'controllers: [ProbeController],' : ''} }) };`,
  );
  await writeFile(module, `${imports.join('\n')}\n${source}`);
}

async function ownedContainer(
  container: { name: string; owner: string },
  args: string[],
): Promise<void> {
  const created = await runCommand(
    [
      'docker',
      'run',
      '-d',
      '--name',
      container.name,
      '--label',
      `dev.starter.owner=${container.owner}`,
      ...args,
    ],
    { cwd: process.cwd(), timeout: 120_000 },
  );
  expect(created.code, created.stderr).toBe(0);
}

test('every capability combination generates, passes project checks and runs with only its declared dependencies', async () => {
  const workspace = await appWorkspace();
  const owner = randomUUID();
  const postgres = { name: `starter-capabilities-pg-${owner}`, owner };
  const rabbitmq = { name: `starter-capabilities-mq-${owner}`, owner };
  let delivery: string | undefined;
  await withCleanup(async () => {
    const deliveryRoot = await mkdtemp(join(tmpdir(), 'capability-delivery-'));
    delivery = deliveryRoot;
    const names = combinations.map(({ name }) => name);
    for (const combination of combinations) {
      const { name, ...capabilities } = combination;
      await run(
        workspace,
        generate(
          name,
          ...Object.entries(capabilities).map(
            ([capability, enabled]) => `--${capability}=${String(enabled)}`,
          ),
        ),
      );
      const app = join(workspace.root, 'src/apps', name);
      await expectRendered(workspace.root, name);
      expect(await Bun.file(join(app, 'application.json')).json()).toEqual(
        combination,
      );
      // Boundaries reject imports missing from this manifest, so an absent
      // package proves the generated source cannot use that capability's adapter.
      const { dependencies } = z
        .object({ dependencies: z.record(z.string(), z.string()) })
        .parse(await Bun.file(join(app, 'package.json')).json());
      for (const [capability, packages] of [
        ['persistence', ['slonik']],
        ['messaging', ['amqplib', '@starter/rabbitmq']],
        ['exposure', ['@nestjs/graphql', '@nestjs/apollo']],
      ] as const)
        for (const dependency of packages)
          expect(Object.keys(dependencies).includes(dependency), name).toBe(
            combination[capability],
          );
    }
    await run(
      workspace,
      [
        'bun',
        'run',
        'nx',
        'run-many',
        `--projects=${names.join(',')}`,
        '--targets=lint,typecheck',
      ],
      { timeout: 300_000 },
    );
    await run(workspace, ['bun', 'run', 'lint:boundaries'], {
      timeout: 120_000,
    });
    // Workspace migration commands accept a newly declared persistent name
    // without a registry edit and reject applications without persistence.
    for (const { name, persistence } of combinations) {
      const created = await workspace.run([
        'env',
        `DATABASE_APP=${name}`,
        'bun',
        'run',
        'migration:create',
        'declaration-check',
      ]);
      expect(created.code, created.stdout + created.stderr).toBe(
        persistence ? 0 : 1,
      );
      if (!persistence) {
        expect(created.stdout + created.stderr).toContain(
          `Unknown database application: ${name}`,
        );
        continue;
      }
      const migrations = join(
        workspace.root,
        'src/apps',
        name,
        'database/migrations',
      );
      const [migration] = (await readdir(migrations)).filter((file) =>
        file.endsWith('_declaration-check.sql'),
      );
      expect(migration, name).toBeDefined();
      await rm(join(migrations, migration));
    }
    for (const combination of combinations)
      await addProbes(
        join(workspace.root, 'src/apps', combination.name),
        combination,
      );
    await run(
      workspace,
      [
        'bun',
        'run',
        'nx',
        'run-many',
        `--projects=${names.join(',')}`,
        '--target=distribution',
      ],
      { timeout: 300_000 },
    );
    for (const name of names)
      await cp(join(workspace.root, 'dist', name), join(deliveryRoot, name), {
        recursive: true,
        verbatimSymlinks: true,
      });
    // The workspace is gone before any delivered application executes.
    await workspace.cleanup();

    const images = z
      .object({
        services: z.object({
          rabbitmq: z.object({ image: z.string() }),
          'postgres-wallet': z.object({ image: z.string() }),
        }),
      })
      .parse(composeProbeConfiguration('runtime', owner)).services;
    const postgresPort = await availablePort();
    const ownerPassword = randomUUID();
    const brokerPort = await availablePort();
    const brokerPassword = randomUUID();
    await Promise.all([
      ownedContainer(postgres, [
        '--tmpfs',
        '/var/lib/postgresql',
        '-p',
        `127.0.0.1:${String(postgresPort)}:5432`,
        '-e',
        'POSTGRES_USER=owner',
        '-e',
        `POSTGRES_PASSWORD=${ownerPassword}`,
        images['postgres-wallet'].image,
      ]),
      ownedContainer(rabbitmq, [
        '--tmpfs',
        '/var/lib/rabbitmq',
        '-p',
        `127.0.0.1:${String(brokerPort)}:5672`,
        '-e',
        'RABBITMQ_DEFAULT_USER=probe',
        '-e',
        `RABBITMQ_DEFAULT_PASS=${brokerPassword}`,
        images.rabbitmq.image,
      ]),
    ]);
    const ownerConnection = (database = 'postgres') => ({
      host: '127.0.0.1',
      port: postgresPort,
      user: 'owner',
      password: ownerPassword,
      database,
    });
    const broker = `amqp://probe:${brokerPassword}@127.0.0.1:${String(brokerPort)}`;
    await until(
      async () => {
        const client = new pg.Client(ownerConnection());
        try {
          await client.connect();
          await client.query('SELECT 1');
          return true;
        } catch {
          return false;
        } finally {
          await client.end().catch(() => undefined);
        }
      },
      60_000,
      'PostgreSQL startup',
    );
    await until(
      async () => {
        try {
          const connection = await connect(broker, { timeout: 1_000 });
          await connection.close();
          return true;
        } catch {
          return false;
        }
      },
      90_000,
      'RabbitMQ startup',
    );
    const runtimePassword = randomUUID();
    const admin = new pg.Client(ownerConnection());
    await admin.connect();
    await withCleanup(async () => {
      for (const { name } of combinations.filter((c) => c.persistence)) {
        // Operator provisioning: the runtime role exists before migrations grant it.
        await admin.query(
          `CREATE ROLE ${role(name)} LOGIN PASSWORD '${runtimePassword}'`,
        );
        await admin.query(`CREATE DATABASE ${identifier(name)}`);
      }
    }, [() => admin.end()]);
    const publisher = await connect(broker);
    await withCleanup(async () => {
      const channel = await publisher.createConfirmChannel();
      for (const combination of combinations)
        await checkCombination(combination, {
          artifact: join(deliveryRoot, combination.name),
          postgresPort,
          ownerConnection,
          runtimePassword,
          broker: { port: brokerPort, password: brokerPassword },
          channel,
        }).catch((error: unknown) => {
          throw new Error(`${combination.name}: ${String(error)}`, {
            cause: error,
          });
        });
      await channel.close();
    }, [() => publisher.close()]);
  }, [
    () => workspace.cleanup(),
    () => delivery && rm(delivery, { recursive: true, force: true }),
    () => removeOwnedContainer(postgres),
    () => removeOwnedContainer(rabbitmq),
  ]);
}, 900_000);

async function checkCombination(
  combination: Combination,
  context: {
    artifact: string;
    postgresPort: number;
    ownerConnection: (database?: string) => pg.ClientConfig;
    runtimePassword: string;
    broker: { port: number; password: string };
    channel: Awaited<
      ReturnType<Awaited<ReturnType<typeof connect>>['createConfirmChannel']>
    >;
  },
): Promise<void> {
  const { name, persistence, messaging, exposure } = combination;
  const { artifact, channel } = context;
  const env = prefix(name);
  const database = identifier(name);
  const scripts = z
    .object({ scripts: z.record(z.string(), z.string()) })
    .parse(await Bun.file(join(artifact, 'package.json')).json()).scripts;
  expect(Object.keys(scripts).sort()).toEqual(
    persistence
      ? [
          'migration:down',
          'migration:status',
          'migration:up',
          'preflight',
          'start',
        ]
      : ['preflight', 'start'],
  );
  if (persistence) {
    const migrated = await runCommand(
      [process.execPath, '--no-env-file', 'run', 'migration:up'],
      {
        cwd: artifact,
        env: {
          PATH: process.env.PATH,
          ...databaseSettings(name, {
            port: String(context.postgresPort),
            database,
            username: 'owner',
            password: String(context.ownerConnection().password),
            credential: 'MIGRATION_',
          }),
        },
      },
    );
    expect(migrated.code, migrated.stdout + migrated.stderr).toBe(0);
  }
  const queue = `${name}.commands.v1`;
  if (messaging) await channel.assertQueue(queue, { durable: true });
  const committed = async (id: string) => {
    const client = new pg.Client(context.ownerConnection(database));
    await client.connect();
    try {
      const result = await client.query<{ source: string }>(
        'SELECT source FROM probe_records WHERE id = $1',
        [id],
      );
      return result.rows[0]?.source;
    } finally {
      await client.end();
    }
  };
  const publish = async (id: string) => {
    channel.sendToQueue(
      queue,
      Buffer.from(JSON.stringify({ pattern: 'probe.v1', data: {} })),
      { persistent: true, messageId: id, correlationId: `${id}-correlation` },
    );
    await channel.waitForConfirms();
  };
  // Register every gate for cleanup as soon as it opens.
  const gates: { close(): Promise<void> }[] = [];
  const opened = async <Gate extends { close(): Promise<void> }>(
    gate: Promise<Gate>,
  ) => {
    const value = await gate;
    gates.push(value);
    return value;
  };
  await withCleanup(async () => {
    const databaseGate = await opened(
      tcpGate({ hostname: '127.0.0.1', port: context.postgresPort }),
    );
    const messagingGate = await opened(
      brokerGate({ hostname: '127.0.0.1', port: context.broker.port }),
    );
    const sentinel = await opened(tcpGate());
    const enabled = (brokerPort: string): Record<string, string> => ({
      ...(persistence &&
        databaseSettings(name, {
          port: databaseGate.port,
          database,
          username: role(name),
          password: context.runtimePassword,
        })),
      ...(messaging && {
        [`${env}_RABBITMQ_URL`]: `amqp://probe:${context.broker.password}@127.0.0.1:${brokerPort}`,
      }),
    });
    const ready = async (url: string) => {
      const result = parseReadinessSnapshot(
        await (await fetch(`${url}/health/ready`)).json(),
        { name, persistence, messaging, exposure },
      );
      if (!result.valid) throw new Error(result.reason);
      return result.snapshot;
    };
    const status = async (url: string, component: string) =>
      (await fetch(`${url}/health/ready/${component}`)).status;
    databaseGate.allow();
    // Disabled capabilities receive no settings at all: none can be required.
    await withApp(
      {
        cwd: artifact,
        command: ['run', 'start'],
        prefix: env,
        settings: enabled(messagingGate.port),
      },
      async ({ url, logs, stop }) => {
        expect(await (await fetch(`${url}/health/live`)).json()).toEqual({
          service: name,
          status: 'alive',
        });
        await until(async () => (await status(url, 'http')) === 200);
        const initial = await ready(url);
        expect(initial).toMatchObject({
          service: name,
          http: { status: 'ready' },
          database: { status: persistence ? 'ready' : 'not_applicable' },
          // HTTP starts while the broker is still unreachable.
          consumer: { status: messaging ? 'not_ready' : 'not_applicable' },
          publisher: { status: 'not_applicable' },
        });
        expect((await fetch(`${url}/health/ready`)).status).toBe(
          messaging ? 503 : 200,
        );
        const graphql = await fetch(`${url}/graphql`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ query: '{ httpReady }' }),
        });
        expect(graphql.status).toBe(exposure ? 200 : 404);
        if (exposure)
          expect(await graphql.json()).toEqual({ data: { httpReady: true } });
        const business = await fetch(`${url}/probe/startup`);
        expect(business.status).toBe(exposure ? 200 : 404);
        if (exposure)
          expect(await business.json()).toEqual({
            id: 'startup',
            source: persistence ? 'bootstrap' : 'unpersisted',
          });
        if (persistence) expect(await committed('startup')).toBe('bootstrap');
        if (messaging) {
          const handled = async (id: string) =>
            persistence
              ? (await committed(id)) === 'message'
              : logs()
                  .split('\n')
                  .some(
                    (line) =>
                      line.includes('consumer.completed') && line.includes(id),
                  );
          messagingGate.allow();
          await until(async () => (await status(url, 'consumer')) === 200);
          await publish(`${name}-first`);
          await until(() => handled(`${name}-first`));
          messagingGate.block();
          await until(async () => (await status(url, 'consumer')) === 503);
          // Broker loss keeps HTTP readiness and business operations usable.
          expect(await status(url, 'http')).toBe(200);
          if (exposure)
            expect((await fetch(`${url}/probe/startup`)).status).toBe(200);
          await publish(`${name}-recovered`);
          messagingGate.allow();
          await until(() => handled(`${name}-recovered`));
          expect((await channel.checkQueue(queue)).messageCount).toBe(0);
        }
        if (persistence) {
          databaseGate.block();
          await until(async () => (await status(url, 'http')) === 503);
          expect(await ready(url)).toMatchObject({
            http: { status: 'not_ready' },
            database: { status: 'not_ready' },
            ...(messaging && {
              consumer: { status: 'not_ready', reason: 'database_unavailable' },
            }),
          });
          expect((await fetch(`${url}/health/live`)).status).toBe(200);
          databaseGate.allow();
          await until(async () => (await status(url, 'http')) === 200);
        }
        await stop();
        if (messaging)
          expect((await channel.checkQueue(queue)).consumerCount).toBe(0);
      },
    );
    // Conventional settings for disabled capabilities point at a sentinel that
    // must never be contacted, including while every probe is read.
    await withApp(
      {
        cwd: artifact,
        command: ['run', 'start'],
        prefix: env,
        settings: {
          ...enabled(String(context.broker.port)),
          ...(!persistence &&
            databaseSettings(name, {
              port: sentinel.port,
              database: 'sentinel',
              username: 'sentinel',
              password: 'sentinel',
            })),
          ...(!messaging && {
            [`${env}_RABBITMQ_URL`]: `amqp://sentinel:sentinel@127.0.0.1:${sentinel.port}`,
          }),
        },
      },
      async ({ url }) => {
        await until(async () => (await fetch(`${url}/health/ready`)).ok);
        for (const component of ['http', 'database', 'consumer', 'publisher'])
          expect(await status(url, component)).toBe(200);
        await Bun.sleep(1_000);
        expect(sentinel.attempts()).toBe(0);
      },
    );
  }, [
    // Attempt every close and keep each failure, as separate cleanups would.
    async () => {
      const failures = (
        await Promise.allSettled(gates.map((gate) => gate.close()))
      ).flatMap((result) =>
        result.status === 'rejected' ? [result.reason as unknown] : [],
      );
      if (failures.length)
        throw new AggregateError(failures, 'TCP gate cleanup failed');
    },
  ]);
}

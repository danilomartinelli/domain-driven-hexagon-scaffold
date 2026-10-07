import { expect } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { Client } from 'pg';
import { connect } from 'amqplib';
import { z } from 'zod';
import { readEnvironmentFile } from '../../../database/environment';
import { runCommand } from '../../lib/command';
import { stopStartup, until } from '../app-runtime-fixture';
import { withCleanup } from '../cleanup';

const manifest = readEnvironmentFile(process.env.DDH_ENVIRONMENT_FILE ?? '');
const [app] = manifest.topology ?? [];
if (manifest.topology?.length !== 1 || app.name !== 'transition')
  throw new Error('Select only transition');
const evidence = '.context/capability-transition.json';
const identity = {
  owner: manifest.owner,
  databases: manifest.databases,
  broker: manifest.broker,
  applicationPorts: manifest.applicationPorts,
};
const initial = process.argv[2] === 'initial';
if (initial)
  await writeFile(evidence, JSON.stringify(identity), { mode: 0o600 });
else expect(JSON.stringify(identity)).toBe(await Bun.file(evidence).text());
for (const key of [
  'TRANSITION_DB_HOST',
  'TRANSITION_DB_PASSWORD',
  'TRANSITION_DB_MIGRATION_PASSWORD',
])
  expect(Boolean(process.env[key]), key).toBe(app.persistence);
for (const key of ['TRANSITION_RABBITMQ_URL', 'RABBITMQ_PASSWORD'])
  expect(Boolean(process.env[key]), key).toBe(app.messaging);

const docker = (args: string[]) =>
  runCommand(['docker', ...args], { cwd: process.cwd() });
const services = await docker([
  'ps',
  '--filter',
  `label=com.docker.compose.project=${manifest.project}`,
  '--format',
  '{{.Label "com.docker.compose.service"}}',
]);
expect(services.code).toBe(0);
expect(services.stdout.trim().split('\n').filter(Boolean).sort()).toEqual(
  [
    ...(app.persistence ? ['postgres-transition'] : []),
    ...(app.messaging ? ['rabbitmq'] : []),
    ...(app.exposure ? ['gateway'] : []),
  ].sort(),
);

if (app.persistence) {
  const db = new Client({
    host: process.env.TRANSITION_DB_HOST,
    port: Number(process.env.TRANSITION_DB_PORT),
    user: process.env.TRANSITION_DB_USERNAME,
    password: process.env.TRANSITION_DB_PASSWORD,
    database: process.env.TRANSITION_DB_NAME,
  });
  await withCleanup(async () => {
    await db.connect();
    if (initial)
      await db.query(
        "INSERT INTO transition_marker VALUES ('committed before disablement')",
      );
    expect(
      (await db.query<{ id: string }>('SELECT id FROM transition_marker')).rows,
    ).toEqual([{ id: 'committed before disablement' }]);
  }, [() => db.end()]);
}
if (app.messaging) {
  const broker = await connect(process.env.TRANSITION_RABBITMQ_URL ?? '');
  await withCleanup(async () => {
    const channel = await broker.createConfirmChannel();
    const queue = 'transition.pending';
    await channel.assertQueue(queue, { durable: true });
    if (initial) {
      channel.sendToQueue(queue, Buffer.from('accepted before disablement'), {
        persistent: true,
        messageId: 'retained-identity',
      });
      await channel.waitForConfirms();
    }
    expect(await channel.checkQueue(queue)).toMatchObject({
      consumerCount: 0,
      messageCount: 1,
    });
    const message = await channel.get(queue);
    if (!message) throw new Error('Accepted work was lost');
    expect(message.properties.messageId).toBe('retained-identity');
    expect(message.content.toString()).toBe('accepted before disablement');
    await channel.close(); // Unacknowledged work stays accepted and queued.
  }, [() => broker.close()]);
}

const child = Bun.spawn([process.execPath, 'run', 'start'], {
  detached: true,
  stdout: 'pipe',
  stderr: 'pipe',
});
const output = Promise.all([
  new Response(child.stdout).text(),
  new Response(child.stderr).text(),
]);
await withCleanup(async () => {
  let container = '';
  await until(
    async () => {
      if (child.exitCode !== null) throw new Error((await output).join('\n'));
      const found = await docker([
        'ps',
        '-q',
        '--filter',
        `label=com.docker.compose.project=${manifest.project}`,
        '--filter',
        'label=com.docker.compose.service=app-transition',
      ]);
      expect(found.code).toBe(0);
      container = found.stdout.trim();
      if (!container) return false;
      const ready = await docker([
        'exec',
        container,
        'bun',
        '-e',
        `process.exit((await fetch('http://127.0.0.1:${String(manifest.applicationPorts.transition)}/health/ready')).ok ? 0 : 1)`,
      ]);
      return ready.code === 0;
    },
    180_000,
    'Transition application startup',
  );
  const probe = await docker([
    'exec',
    container,
    'bun',
    '-e',
    `
    const url = 'http://127.0.0.1:${String(manifest.applicationPorts.transition)}';
    console.log(JSON.stringify({ health: await (await fetch(url + '/health/ready')).json(), graphql: (await fetch(url + '/graphql')).status }));
  `,
  ]);
  expect(probe.code, probe.stderr).toBe(0);
  const result = z
    .object({ health: z.unknown(), graphql: z.number() })
    .parse(JSON.parse(probe.stdout));
  expect(result.health).toMatchObject({
    http: { status: 'ready' },
    database: { status: app.persistence ? 'ready' : 'not_applicable' },
    consumer: { status: app.messaging ? 'ready' : 'not_applicable' },
  });
  if (!app.exposure) expect(result.graphql).toBe(404);
  if (app.exposure) {
    const query = () =>
      fetch(
        `http://127.0.0.1:${String(manifest.gateway?.proxyPort)}/transition/graphql`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ query: '{ httpReady }' }),
        },
      );
    await until(
      () =>
        query().then(
          (response) => response.ok,
          () => false,
        ),
      30_000,
      'Gateway transition readiness',
    );
    const response = await query();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { httpReady: true } });
  }
  const ports = await docker(['port', container]);
  expect(ports.code).toBe(0);
  expect(ports.stdout.trim()).toBe('');
}, [() => stopStartup(child, output)]);

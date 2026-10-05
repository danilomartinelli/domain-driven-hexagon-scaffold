import { expect } from 'bun:test';
import { Client } from 'pg';
import { connect } from 'amqplib';
import {
  readEnvironmentFile,
  assertTestEnvironment,
} from '../../../database/environment';
import { runCommand } from '../../lib/command';
import { stopStartup, until } from '../app-runtime-fixture';
import { withCleanup } from '../cleanup';

const [name, persistence, messaging, exposure, startup] = process.argv.slice(2);
assertTestEnvironment();
const manifest = readEnvironmentFile(process.env.DDH_ENVIRONMENT_FILE ?? '');
const prefix = name.replaceAll('-', '_').toUpperCase();
const p = persistence === 'true';
const m = messaging === 'true';
const e = exposure === 'true';
const expected = [
  ...(p ? [`postgres-${name}`] : []),
  ...(m ? ['rabbitmq'] : []),
  ...(e ? ['gateway'] : []),
].sort();
const containers = await runCommand(
  [
    'docker',
    'ps',
    '--filter',
    `label=com.docker.compose.project=${manifest.project}`,
    '--format',
    '{{.Label "com.docker.compose.service"}}',
  ],
  { cwd: process.cwd() },
);
expect(containers.code).toBe(0);
expect(containers.stdout.trim().split('\n').filter(Boolean).sort()).toEqual(
  expected,
);
expect(manifest.databases.length).toBe(p ? 1 : 0);
expect(!!process.env.RABBITMQ_PASSWORD).toBe(m);
expect(!!process.env[`${prefix}_RABBITMQ_URL`]).toBe(m);
expect(!!process.env[`${prefix}_DB_PASSWORD`]).toBe(p);
expect(!!process.env.GATEWAY_PROXY_PORT).toBe(e);

if (p) {
  const client = new Client({
    host: process.env[`${prefix}_DB_HOST`],
    port: Number(process.env[`${prefix}_DB_PORT`]),
    user: process.env[`${prefix}_DB_USERNAME`],
    password: process.env[`${prefix}_DB_PASSWORD`],
    database: process.env[`${prefix}_DB_NAME`],
  });
  await withCleanup(async () => {
    await client.connect();
    await client.query('INSERT INTO selected_marker VALUES ($1)', ['durable']);
    expect(
      (await client.query<{ id: string }>('SELECT id FROM selected_marker'))
        .rows,
    ).toEqual([{ id: 'durable' }]);
  }, [() => client.end()]);
}
if (m) {
  const broker = await connect(process.env[`${prefix}_RABBITMQ_URL`] ?? '');
  await withCleanup(async () => {
    const channel = await broker.createConfirmChannel();
    await channel.assertQueue('selected.probe', { durable: true });
    channel.sendToQueue('selected.probe', Buffer.from('accepted-work'), {
      persistent: true,
      messageId: 'selected-identity',
    });
    await channel.waitForConfirms();
    const message = await channel.get('selected.probe');
    if (!message) throw new Error('Accepted work missing');
    expect(message.properties.messageId).toBe('selected-identity');
    expect(message.content.toString()).toBe('accepted-work');
    channel.ack(message);
    await channel.close();
  }, [() => broker.close()]);
}

// Exercise the public startup command: selection and names come from the environment.
const child = Bun.spawn(
  startup === 'direct'
    ? [process.execPath, '--no-env-file', `src/apps/${name}/main.ts`]
    : [process.execPath, 'run', 'start'],
  {
    detached: true,
    stdout: 'pipe',
    stderr: 'pipe',
  },
);
const output = Promise.all([
  new Response(child.stdout).text(),
  new Response(child.stderr).text(),
]);
const direct = `http://127.0.0.1:${String(manifest.applicationPorts[name])}`;
await withCleanup(async () => {
  await until(async () => {
    if (child.exitCode !== null) throw new Error((await output).join('\n'));
    return fetch(`${direct}/health/live`).then(
      (response) => response.ok,
      () => false,
    );
  }, 30000);
  if (e) {
    const gateway = `http://127.0.0.1:${process.env.GATEWAY_PROXY_PORT ?? ''}`;
    const response = await fetch(`${gateway}/${name}/graphql`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: '{ httpReady }' }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { httpReady: true } });
    for (const path of ['/health/live', '/graphql', '/v1/users'])
      expect((await fetch(gateway + path)).status).toBe(404);
  } else {
    expect((await fetch(`${direct}/graphql`)).status).toBe(404);
  }
}, [
  async () => {
    await stopStartup(child, output);
    await until(() =>
      fetch(`${direct}/health/live`).then(
        () => false,
        () => true,
      ),
    );
  },
]);

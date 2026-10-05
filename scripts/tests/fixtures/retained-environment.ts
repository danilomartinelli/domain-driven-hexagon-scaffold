import { expect } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { Client } from 'pg';
import { connect } from 'amqplib';
import { z } from 'zod';
import { readEnvironmentFile } from '../../../database/environment';
import { stopStartup, until } from '../app-runtime-fixture';
import { withCleanup } from '../cleanup';
import { runCommand } from '../../lib/command';

const manifest = readEnvironmentFile(process.env.DDH_ENVIRONMENT_FILE ?? '');
const phase = process.argv[2];
const evidence = '.context/retained-evidence.json';
const eventSchema = z.object({ event_id: z.string(), user_id: z.string() });
const evidenceSchema = z.object({
  owner: z.string(),
  databases: z.array(z.unknown()),
  broker: z.unknown(),
  applicationPorts: z.record(z.string(), z.number()),
  events: z.array(eventSchema),
});
const settings = (app: string) => {
  const prefix = app.toUpperCase() + '_DB';
  return {
    host: process.env[`${prefix}_HOST`],
    port: Number(process.env[`${prefix}_PORT`]),
    user: process.env[`${prefix}_MIGRATION_USERNAME`],
    password: process.env[`${prefix}_MIGRATION_PASSWORD`],
    database: process.env[`${prefix}_NAME`],
  };
};
const save = (value: unknown) =>
  writeFile(evidence, JSON.stringify(value), { mode: 0o600 });

async function withService(app: string, use: () => Promise<void>) {
  const child = Bun.spawn([process.execPath, 'run', `start:${app}`], {
    detached: true,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const logs = Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  await withCleanup(async () => {
    await until(async () => {
      if (child.exitCode !== null) throw new Error((await logs).join('\n'));
      return fetch(
        `http://127.0.0.1:${String(manifest.applicationPorts[app])}/health/live`,
      ).then(
        (r) => r.ok,
        () => false,
      );
    }, 30000);
    await use();
  }, [() => stopStartup(child, logs)]);
}

if (phase === 'record') {
  await save({ ...manifest, events: [] });
  const db = new Client(settings('user'));
  await withCleanup(async () => {
    await db.connect();
    await db.query(
      'CREATE TABLE retention_marker (id integer PRIMARY KEY); INSERT INTO retention_marker VALUES (42)',
    );
  }, [() => db.end()]);
} else {
  const before = evidenceSchema.parse(await Bun.file(evidence).json());
  expect(manifest.owner).toBe(before.owner);
  expect(JSON.stringify(manifest.broker)).toBe(JSON.stringify(before.broker));
  for (const db of before.databases)
    expect(manifest.databases.map((entry) => JSON.stringify(entry))).toContain(
      JSON.stringify(db),
    );
  for (const [app, port] of Object.entries(before.applicationPorts))
    expect(manifest.applicationPorts[app]).toBe(port);
  if (phase === 'inactive') {
    expect(process.env.WALLET_DB_PASSWORD).toBeUndefined();
    expect(process.env.WALLET_RABBITMQ_URL).toBeUndefined();
    const containers = await runCommand(
      [
        'docker',
        'ps',
        '-q',
        '--filter',
        `label=com.docker.compose.project=${manifest.project}`,
        '--filter',
        'label=com.docker.compose.service=postgres-wallet',
      ],
      { cwd: process.cwd() },
    );
    expect(containers.code).toBe(0);
    expect(containers.stdout.trim()).toBe('');
    const response = await fetch(
      `http://127.0.0.1:${process.env.GATEWAY_PROXY_PORT ?? ''}/v1/wallets/by-user/retained`,
    );
    expect(response.status).toBe(404);
  }
  if (phase === 'produce') {
    const db = new Client(settings('user'));
    await withCleanup(async () => {
      await db.connect();
      expect(
        (await db.query<{ id: number }>('SELECT id FROM retention_marker'))
          .rows,
      ).toEqual([{ id: 42 }]);
      await withService('user', async () => {
        const response = await fetch(
          `http://127.0.0.1:${process.env.GATEWAY_PROXY_PORT ?? ''}/v1/users`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              email: `retained-${String(before.events.length)}@example.com`,
              country: 'England',
              street: 'Baker street',
              postalCode: 'NW16XE',
            }),
          },
        );
        expect(response.status).toBe(201);
        const { id } = z
          .object({ id: z.string() })
          .parse(await response.json());
        await until(
          async () =>
            (
              await db.query(
                "SELECT 1 FROM user_outbox WHERE envelope->'data'->>'userId' = $1 AND published_at IS NOT NULL",
                [id],
              )
            ).rowCount === 1,
        );
        const row = (
          await db.query(
            "SELECT event_id, envelope->'data'->>'userId' AS user_id FROM user_outbox WHERE envelope->'data'->>'userId' = $1",
            [id],
          )
        ).rows[0] as unknown;
        before.events.push(eventSchema.parse(row));
        await save(before);
      });
    }, [() => db.end()]);
  }
  if (phase === 'produce' || phase === 'backlog') {
    const connection = await connect(process.env.USER_RABBITMQ_URL ?? '');
    await withCleanup(async () => {
      const channel = await connection.createChannel();
      const queue = await channel.checkQueue('wallet.user-created');
      expect(queue.consumerCount).toBe(0);
      expect(queue.messageCount).toBe(before.events.length);
      const ids: string[] = [];
      for (let index = 0; index < before.events.length; index++) {
        const message = await channel.get('wallet.user-created');
        if (!message) throw new Error('Retained message missing');
        const body = z
          .object({ eventId: z.string() })
          .parse(JSON.parse(message.content.toString()));
        ids.push(body.eventId);
      }
      expect(ids.sort()).toEqual(
        before.events.map((event) => event.event_id).sort(),
      );
      // Closing with unacked deliveries requeues the exact accepted envelopes.
      await channel.close();
    }, [() => connection.close()]);
  }
  if (phase === 'consume') {
    const db = new Client(settings('wallet'));
    await withCleanup(async () => {
      await db.connect();
      await withService('wallet', async () => {
        await until(
          async () =>
            (await db.query('SELECT 1 FROM wallet_consumed_events'))
              .rowCount === before.events.length,
        );
        const consumed = (
          await db.query(
            'SELECT event_id, user_id FROM wallet_consumed_events ORDER BY event_id',
          )
        ).rows as unknown[];
        expect(consumed.map((row) => eventSchema.parse(row))).toEqual(
          [...before.events].sort((a, b) =>
            a.event_id.localeCompare(b.event_id),
          ),
        );
        for (const event of before.events) {
          const response = await fetch(
            `http://127.0.0.1:${process.env.GATEWAY_PROXY_PORT ?? ''}/v1/wallets/by-user/${event.user_id}`,
          );
          expect(response.status).toBe(200);
          expect(await response.json()).toMatchObject({
            userId: event.user_id,
            balance: 0,
          });
        }
      });
    }, [() => db.end()]);
  }
}

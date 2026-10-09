import { expect, test } from 'bun:test';
import { connect } from 'amqplib';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { runCommand } from '../lib/command';
import { availablePort } from '../lib/environments';
import {
  appWorkspace,
  generate,
  replaceOnce,
  run,
} from './app-generator-fixture';
import { until, withApp } from './app-runtime-fixture';
import { brokerGate } from './broker-gate';
import { withCleanup } from './cleanup';
import { composeProbeConfiguration } from './compose-fixture';
import { removeOwnedContainer } from './owned-container';

type Scenario =
  'baseline' | 'timeout-overlap' | 'timeout-drain' | 'rejection' | 'retention';

async function checkScenario(scenario: Scenario): Promise<void> {
  const workspace = await appWorkspace();
  const container = {
    name: `starter-generator-${randomUUID()}`,
    owner: randomUUID(),
  };
  const port = await availablePort();
  const password = randomUUID();
  const broker = `amqp://probe:${password}@127.0.0.1:${String(port)}`;
  await withCleanup(async () => {
    await run(workspace, generate('telemetry'));
    const app = join(workspace.root, 'src/apps/telemetry');
    // Test-owned behavior, never part of generated output or a sibling service.
    await writeFile(
      join(app, 'application/probe.ts'),
      `
      import type { MessageHandler, MessageMetadata } from './message-handler';
      export const received: { data: unknown; metadata: MessageMetadata }[] = [];
      export const activity = { active: 0, maximum: 0 };
      let rejectOnce = true;
      let timeoutOnce = true;
      export const probe: MessageHandler = {
        pattern: 'probe.v1',
        async handle(data, metadata) {
          activity.active++;
          activity.maximum = Math.max(activity.maximum, activity.active);
          try {
          if (data === 'invalid') return { accepted: false, reason: 'invalid-probe' } as const;
          if (data === 'drain-timeout') await new Promise<void>((resolve) => { setTimeout(resolve, 20_000); });
          if (data === 'retry' && rejectOnce) {
            rejectOnce = false;
            throw new Error('probe-private-error');
          }
          if (data === 'timeout' && timeoutOnce) {
            timeoutOnce = false;
            await new Promise<void>((resolve) => { setTimeout(resolve, 11_000); });
            throw new Error('probe-private-timeout');
          }
          await new Promise<void>((resolve) => { setTimeout(resolve, 500); });
          received.push({ data, metadata });
          } finally { activity.active--; }
        },
      };
    `,
    );
    await writeFile(
      join(app, 'adapters/probe.controller.ts'),
      `
      import { Controller, Get, Inject, Post } from '@nestjs/common';
      import { RabbitMessageConsumer } from './rabbitmq.consumer';
      import { received, activity } from '../application/probe';
      @Controller('probe')
      export class ProbeController {
        constructor(@Inject(RabbitMessageConsumer) private readonly consumer: RabbitMessageConsumer) {}
        @Post('stop') async stop(): Promise<typeof activity> { await this.consumer.stop(); return { ...activity }; }
        @Get() read(): typeof received { return received; }
        @Get('activity') activity(): typeof activity { return activity; }
      }
    `,
    );
    const module = join(app, 'composition/app.module.ts');
    const registration = join(app, 'composition.json');
    const registered = JSON.parse(await readFile(registration, 'utf8')) as {
      integrations: string[];
      groups: unknown[];
    };
    registered.groups.push({ name: 'probe', requires: ['messaging'] });
    await writeFile(registration, JSON.stringify(registered));
    const composition = replaceOnce(
      await readFile(module, 'utf8'),
      "const functionality: ApplicationFactories['groups'] = {};",
      "const functionality: ApplicationFactories['groups'] = { probe: () => ({ providers: [{ provide: 'probe', useValue: probe }], handlers: ['probe'], controllers: [ProbeController] }) };",
    );
    await writeFile(
      module,
      composition +
        "\nimport { probe } from '../application/probe';\nimport { ProbeController } from '../adapters/probe.controller';\n",
    );
    // Every scenario emits the same probe source; check its static contracts once.
    if (scenario === 'baseline') {
      await run(workspace, [
        'bun',
        'run',
        'nx',
        'run-many',
        '--projects=telemetry',
        '--targets=lint,typecheck',
      ]);
      await run(workspace, ['bun', 'run', 'lint:boundaries']);
    }
    const image = z
      .object({
        services: z.object({ rabbitmq: z.object({ image: z.string() }) }),
      })
      .parse(composeProbeConfiguration('runtime', container.owner)).services
      .rabbitmq.image;
    const created = await runCommand(
      [
        'docker',
        'run',
        '-d',
        '--name',
        container.name,
        '--label',
        `dev.starter.owner=${container.owner}`,
        '--tmpfs',
        '/var/lib/rabbitmq',
        '-p',
        `127.0.0.1:${String(port)}:5672`,
        '-e',
        'RABBITMQ_DEFAULT_USER=probe',
        '-e',
        `RABBITMQ_DEFAULT_PASS=${password}`,
        image,
      ],
      { cwd: workspace.root, timeout: 90_000 },
    );
    expect(created.code, created.stderr).toBe(0);
    await until(async () => {
      try {
        const connection = await connect(broker, { timeout: 1_000 });
        await connection.close();
        return true;
      } catch {
        return false;
      }
    }, 60_000);
    const gate = await brokerGate({ hostname: '127.0.0.1', port });
    await withCleanup(async () => {
      const connection = await connect(broker);
      await withCleanup(async () => {
        const channel = await connection.createConfirmChannel();
        const queue = 'telemetry.commands.v1';
        await channel.assertQueue(queue, { durable: true });
        await withApp(
          {
            cwd: workspace.root,
            command: ['src/apps/telemetry/main.ts'],
            settings: {
              TELEMETRY_RABBITMQ_URL: `amqp://probe:${password}@127.0.0.1:${gate.port}`,
            },
          },
          async ({ url, stop, logs }) => {
            expect((await fetch(`${url}/health/ready/http`)).status).toBe(200);
            expect((await fetch(`${url}/health/ready/consumer`)).status).toBe(
              503,
            );
            const graphql = await fetch(`${url}/graphql`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ query: '{ httpReady }' }),
            });
            expect(await graphql.json()).toEqual({ data: { httpReady: true } });
            gate.allow();
            await until(
              async () => (await fetch(`${url}/health/ready/consumer`)).ok,
            );
            const publish = async (data: string) => {
              channel.sendToQueue(
                queue,
                Buffer.from(JSON.stringify({ pattern: 'probe.v1', data })),
                {
                  persistent: true,
                  messageId: `event-${data}`,
                  correlationId: `correlation-${data}`,
                },
              );
              await channel.waitForConfirms();
            };
            if (scenario === 'timeout-overlap') {
              await publish('timeout');
              await until(
                async () =>
                  (
                    (await fetch(`${url}/probe`).then((r) =>
                      r.json(),
                    )) as unknown[]
                  ).length === 1,
              );
              expect(
                await fetch(`${url}/probe/activity`).then((r) => r.json()),
              ).toMatchObject({ maximum: 1 });
              return;
            }
            if (scenario === 'timeout-drain') {
              await publish('drain-timeout');
              await until(() =>
                Promise.resolve(logs().includes('consumer.failed')),
              );
              expect(
                await fetch(`${url}/probe/stop`, { method: 'POST' }).then((r) =>
                  r.json(),
                ),
              ).toMatchObject({ active: 0 });
              await stop();
              const lines = logs().split('\n');
              const settled = lines.findIndex(
                (line) =>
                  line.includes('consumer.completed') &&
                  line.includes('event-drain-timeout'),
              );
              const shutdown = lines.findIndex((line) =>
                line.includes('shutdown.completed'),
              );
              expect(settled).toBeGreaterThanOrEqual(0);
              expect(settled).toBeLessThan(shutdown);
              return;
            }
            if (scenario === 'rejection') {
              await publish('invalid');
              await publish('valid');
              await until(
                async () =>
                  (
                    (await fetch(`${url}/probe`).then((r) =>
                      r.json(),
                    )) as unknown[]
                  ).length === 1,
              );
              expect(
                (await channel.checkQueue(`${queue}.failed`)).messageCount,
              ).toBe(1);
              const failed = await channel.get(`${queue}.failed`, {
                noAck: true,
              });
              expect(failed && failed.content.toString()).toBe(
                JSON.stringify({ pattern: 'probe.v1', data: 'invalid' }),
              );
              expect(failed && failed.properties.headers).toMatchObject({
                'failure-reason': 'invalid-probe',
              });
              expect(logs()).not.toContain('consumer.failed');
              expect((await fetch(`${url}/health/ready/consumer`)).ok).toBe(
                true,
              );
              return;
            }
            if (scenario === 'retention') {
              for (const sample of [
                {
                  body: 'invalid-json',
                  identity: { messageId: 'partial-event' },
                  reason: 'invalid-json',
                },
                {
                  body: JSON.stringify({ pattern: 'probe.v1', data: 0 }),
                  identity: { correlationId: 'partial-correlation' },
                  reason: 'missing-identity',
                },
                {
                  body: '{}',
                  identity: {
                    messageId: 'envelope-event',
                    correlationId: 'envelope-correlation',
                  },
                  reason: 'invalid-envelope',
                },
                {
                  body: JSON.stringify({ pattern: 'unknown.v1', data: null }),
                  identity: {
                    messageId: 'unknown-event',
                    correlationId: 'unknown-correlation',
                  },
                  reason: 'unknown-pattern',
                },
              ]) {
                channel.sendToQueue(queue, Buffer.from(sample.body), {
                  persistent: true,
                  ...sample.identity,
                  expiration: '60000',
                  contentType: 'application/json',
                  contentEncoding: 'utf-8',
                  type: 'probe',
                  headers: {
                    source: 'producer-private',
                    'failure-reason': 'untrusted',
                  },
                });
                await channel.waitForConfirms();
                await until(
                  async () =>
                    (await channel.checkQueue(`${queue}.failed`))
                      .messageCount === 1,
                );
                const failed = await channel.get(`${queue}.failed`, {
                  noAck: true,
                });
                expect(failed && failed.properties).toMatchObject({
                  ...sample.identity,
                  contentType: 'application/json',
                  contentEncoding: 'utf-8',
                  type: 'probe',
                  headers: {
                    source: 'producer-private',
                    'failure-reason': sample.reason,
                  },
                });
                expect(failed && failed.properties.expiration).toBeUndefined();
                expect(failed && failed.content.toString()).toBe(sample.body);
                await until(() =>
                  Promise.resolve(logs().includes(sample.reason)),
                );
              }
              expect(logs()).not.toContain('producer-private');
              return;
            }
            await publish('first');
            await until(
              async () =>
                (
                  (await fetch(`${url}/probe`).then((r) =>
                    r.json(),
                  )) as unknown[]
                ).length === 1,
            );
            expect(await fetch(`${url}/probe`).then((r) => r.json())).toEqual([
              {
                data: 'first',
                metadata: {
                  eventId: 'event-first',
                  correlationId: 'correlation-first',
                },
              },
            ]);
            gate.block();
            await until(
              async () =>
                (await fetch(`${url}/health/ready/consumer`)).status === 503,
            );
            await publish('recovered');
            expect((await fetch(`${url}/health/ready/http`)).ok).toBe(true);
            gate.allow();
            await until(
              async () =>
                (
                  (await fetch(`${url}/probe`).then((r) =>
                    r.json(),
                  )) as unknown[]
                ).length === 2,
            );
            for (const [data, count] of [
              ['retry', 3],
              ['timeout', 4],
            ] as const) {
              await publish(data);
              await until(
                async () =>
                  (
                    (await fetch(`${url}/probe`).then((r) =>
                      r.json(),
                    )) as unknown[]
                  ).length === count,
              );
              const failure = logs()
                .split('\n')
                .find(
                  (line) =>
                    line.includes('consumer.failed') &&
                    line.includes(`event-${data}`),
                );
              expect(failure).toBeDefined();
              expect(JSON.parse(failure ?? 'null') as unknown).toMatchObject({
                service: 'telemetry',
                operation: 'consumer.failed',
                eventId: `event-${data}`,
                correlationId: `correlation-${data}`,
              });
            }
            expect(logs()).not.toContain('probe-private-');
            // Unsupported bytes must be retained instead of silently acknowledged.
            channel.sendToQueue(queue, Buffer.from('unsupported'), {
              persistent: true,
              messageId: 'event-unsupported',
              correlationId: 'correlation-unsupported',
            });
            await channel.waitForConfirms();
            await until(
              async () =>
                (await channel.checkQueue(`${queue}.failed`)).messageCount ===
                1,
            );
            const failed = await channel.get(`${queue}.failed`, {
              noAck: true,
            });
            expect(failed && failed.content.toString()).toBe('unsupported');
            await until(() =>
              Promise.resolve(logs().includes('consumer.retained')),
            );
            const retained = logs()
              .split('\n')
              .find((line) => line.includes('consumer.retained'));
            expect(JSON.parse(retained ?? 'null') as unknown).toMatchObject({
              service: 'telemetry',
              operation: 'consumer.retained',
              eventId: 'event-unsupported',
              correlationId: 'correlation-unsupported',
            });
            await publish('drain');
            // Wait for delivery acceptance before signaling the real process.
            await until(
              async () => (await channel.checkQueue(queue)).messageCount === 0,
            );
            await stop();
            expect((await channel.checkQueue(queue)).consumerCount).toBe(0);
            expect(await channel.get(queue, { noAck: true })).toBe(false);
          },
        );
        await channel.close();
      }, [() => connection.close()]);
    }, [() => gate.close()]);
  }, [() => removeOwnedContainer(container), () => workspace.cleanup()]);
}

test(
  'generated hybrid app starts without a broker, recovers deliveries and drains on shutdown',
  () => checkScenario('baseline'),
  180_000,
);
test.each([
  ['waits before redelivering a timed-out handler', 'timeout-overlap'],
  ['keeps timed-out work in the consumer drain', 'timeout-drain'],
  ['retains permanent rejections while consuming valid messages', 'rejection'],
  ['preserves partial identity and retention reasons', 'retention'],
] as const)(
  'generated hybrid consumer %s',
  (_description, scenario) => checkScenario(scenario),
  180_000,
);

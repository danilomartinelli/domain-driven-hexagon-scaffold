import { expect, test } from 'bun:test';
import { rejects } from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { runCommand } from '../lib/command';
import { withCleanup } from './cleanup';
import { composeProbeConfiguration } from './compose-fixture';
import { removeOwnedContainer } from './owned-container';

const root = new URL('../../', import.meta.url).pathname;

function brokerConfiguration() {
  return z
    .object({
      services: z.object({
        rabbitmq: z.object({
          image: z.string(),
          labels: z.object({ 'dev.starter.owner': z.string() }),
          healthcheck: z.object({
            test: z.tuple([z.literal('CMD')]).rest(z.string()),
          }),
        }),
      }),
    })
    .parse(composeProbeConfiguration('runtime', 'fixture-runtime')).services
    .rabbitmq;
}

test('RabbitMQ healthcheck cannot make the startup cookie unreadable to the broker', async () => {
  const broker = brokerConfiguration();
  const container = `starter-cookie-probe-${randomUUID()}`;
  await withCleanup(async () => {
    const result = await runCommand(
      [
        'docker',
        'run',
        '--name',
        container,
        '--label',
        `dev.starter.owner=${broker.labels['dev.starter.owner']}`,
        '--tmpfs',
        '/var/lib/rabbitmq',
        '--entrypoint',
        'sh',
        broker.image,
        '-c',
        // Force the healthcheck between entrypoint ownership setup and broker startup.
        // With no broker running, diagnostics may fail but must leave its cookie readable.
        'chown rabbitmq:rabbitmq /var/lib/rabbitmq && { "$@" >/tmp/healthcheck.log 2>&1 || true; } && su-exec rabbitmq test -r /var/lib/rabbitmq/.erlang.cookie',
        'healthcheck-probe',
        ...broker.healthcheck.test.slice(1),
      ],
      // A fresh CI runner may need to pull the pinned image before the probe.
      { cwd: root, timeout: 90_000 },
    );
    expect(result.code, result.stderr).toBe(0);
  }, [
    () =>
      removeOwnedContainer({
        name: container,
        owner: broker.labels['dev.starter.owner'],
      }),
  ]);
}, 125_000);

test('container cleanup refuses a foreign owner and removes only the owned container', async () => {
  const broker = brokerConfiguration();
  const fixture = {
    name: `starter-owner-probe-${randomUUID()}`,
    owner: broker.labels['dev.starter.owner'],
  };
  await withCleanup(async () => {
    const created = await runCommand(
      [
        'docker',
        'create',
        '--name',
        fixture.name,
        '--label',
        `dev.starter.owner=${fixture.owner}`,
        '--tmpfs',
        '/var/lib/rabbitmq',
        '--entrypoint',
        'sh',
        broker.image,
        '-c',
        'exit 0',
      ],
      { cwd: root, timeout: 30_000 },
    );
    expect(created.code, created.stderr).toBe(0);
    await rejects(
      removeOwnedContainer({ ...fixture, owner: randomUUID() }),
      /owner does not match/,
    );
    const preserved = await runCommand(
      ['docker', 'container', 'inspect', '--format', '{{.Id}}', fixture.name],
      { cwd: root },
    );
    expect(preserved.code, preserved.stderr).toBe(0);
    expect(preserved.stdout.trim()).toBe(created.stdout.trim());
    await removeOwnedContainer(fixture);
    const removed = await runCommand(
      ['docker', 'container', 'inspect', fixture.name],
      { cwd: root },
    );
    expect(removed.code).toBe(1);
    expect(removed.stderr).toContain(`No such container: ${fixture.name}`);
    // Repeated cleanup is successful only when Docker confirms the name is absent.
    await removeOwnedContainer(fixture);
  }, [() => removeOwnedContainer(fixture)]);
}, 90_000);

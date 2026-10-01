import { expect, test } from 'bun:test';
import { connect } from 'amqplib';
import { z } from 'zod';
import {
  assertTestEnvironment,
  readEnvironmentFile,
} from '../../database/environment';
import { runCommand } from '../../scripts/lib/command';
import { withCleanup } from '../../scripts/tests/cleanup';

const output = z.object({
  ready: z.number(),
  messages: z.array(z.object({ receipt: z.string() })),
});
function inspection(stdout: string) {
  const line = stdout.split('\n').find((line) => line.includes('{"queue":'));
  if (!line) throw new Error(`Missing inspection output: ${stdout}`);
  return output.parse(JSON.parse(line.slice(line.indexOf('{'))));
}

test.each(['user', 'wallet'] as const)(
  '%s operator targets execute live in the selected environment and reject broker overrides',
  async (app) => {
    assertTestEnvironment();
    const file = process.env.DDH_ENVIRONMENT_FILE;
    if (!file) throw new Error('Missing manifest');
    const manifest = readEnvironmentFile(file);
    const invoke = (action: string, flags: string[] = [], env = process.env) =>
      runCommand(
        [
          process.execPath,
          '--no-env-file',
          'run',
          'nx',
          'run',
          `${app}:failures-${action}`,
          '--output-style=stream',
          '--environment=test',
          `--run=${manifest.run}`,
          ...flags,
        ],
        {
          cwd: process.cwd(),
          env: { ...env, NX_INVOCATION_ROOT_PID: '' },
          timeout: 30_000,
        },
      );
    const connection = await connect({
      hostname: process.env.RABBITMQ_HOST,
      port: Number(process.env.RABBITMQ_PORT),
      username: process.env.RABBITMQ_USERNAME,
      password: process.env.RABBITMQ_PASSWORD,
      vhost: process.env.RABBITMQ_VHOST,
    });
    await withCleanup(async () => {
      const channel = await connection.createConfirmChannel();
      const queue =
        app === 'user' ? 'user.create.failed' : 'wallet.user-created.failed';
      await channel.assertQueue(queue, { durable: true });
      const first = await invoke('inspect');
      expect(first.code).toBe(0);
      expect(inspection(first.stdout).ready).toBe(0);
      channel.sendToQueue(queue, Buffer.from('{private-invalid-payload'), {
        persistent: true,
        messageId: 'operator-message',
        correlationId: 'operator-correlation',
      });
      await channel.waitForConfirms();
      const second = await invoke('inspect', ['--offset=0', '--limit=1']);
      expect(second.code).toBe(0);
      expect(second.stdout + second.stderr).not.toContain(
        'private-invalid-payload',
      );
      const retained = inspection(second.stdout);
      expect(retained.ready).toBe(1);
      const replay = await invoke('replay', [
        `--message=${retained.messages[0].receipt}`,
      ]);
      expect(replay.code).not.toBe(0);
      expect(replay.stdout).toContain('"status":"retained"');
      expect((await channel.checkQueue(queue)).messageCount).toBe(1);
      const foreign = await invoke('inspect', [], {
        ...process.env,
        RABBITMQ_PORT: '1',
      });
      expect(foreign.code).not.toBe(0);
      expect(foreign.stdout + foreign.stderr).toContain(
        'matching broker settings',
      );
      expect(foreign.stdout + foreign.stderr).not.toContain(
        manifest.broker.password,
      );
      const missing = await runCommand(
        [
          process.execPath,
          '--no-env-file',
          'run',
          'nx',
          'run',
          `${app}:failures-inspect`,
          '--output-style=stream',
        ],
        { cwd: process.cwd(), timeout: 30_000 },
      );
      expect(missing.code).not.toBe(0);
      expect(missing.stdout + missing.stderr).toContain(
        '--environment=test|development --run=<id>',
      );
    }, [() => connection.close()]);
  },
  90_000,
);

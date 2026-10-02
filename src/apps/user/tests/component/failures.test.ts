import { expect, test } from 'bun:test';
import { withCleanup } from '../../../../../scripts/tests/cleanup';
import { z } from 'zod';
import { receive, send, until, withCommands } from './command-fixture';
import { getHttpServer, startUser, stopUser } from './user-process';
import baseline from '../unit/fixtures/user-create-v1.json';

async function operate(...args: string[]) {
  const child = Bun.spawn(
    [
      process.execPath,
      '--no-env-file',
      'src/apps/user/messaging/failures.ts',
      ...args,
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

const inspection = z.object({
  messages: z.array(
    z.object({
      receipt: z.string(),
      eligible: z.boolean(),
      contentBase64: z.string(),
      properties: z.object({
        messageId: z.string(),
        correlationId: z.string(),
        replyTo: z.string(),
      }),
    }),
  ),
});

test('User inspection and replay keep unsupported commands intact across service restart with no profile mutation', async () => {
  await withCommands(async (channel, replies) => {
    const command = { ...baseline, version: 2 };
    await send(channel, replies, command);
    await until(
      async () =>
        (await channel.checkQueue('user.create.failed')).messageCount === 1,
    );
    await stopUser();
    await startUser();
    const result = await operate('inspect', '--payload');
    expect(result.code).toBe(0);
    const retained = inspection.parse(JSON.parse(result.stdout)).messages[0];
    expect(retained).toMatchObject({
      eligible: false,
      contentBase64: Buffer.from(JSON.stringify(command)).toString('base64'),
      properties: {
        messageId: baseline.commandId,
        correlationId: baseline.correlationId,
        replyTo: replies,
      },
    });
    const replay = await operate('replay', `--message=${retained.receipt}`);
    expect(replay.code).toBe(2);
    expect((await channel.checkQueue('user.create.failed')).messageCount).toBe(
      1,
    );
    expect((await channel.checkQueue('user.create')).messageCount).toBe(0);
    expect(
      (await getHttpServer().get('/v1/users').expect(200)).body,
    ).toMatchObject({ count: 0 });
  });
}, 30_000);

test('eligible User replay preserves command correlation and reply routing; repeated replay reports the existing email', async () => {
  await withCommands(async (channel) => {
    const { queue: replies } = await channel.assertQueue(
      'user.replay.test.replies',
      { durable: true },
    );
    await withCleanup(async () => {
      const body = Buffer.from(JSON.stringify(baseline));
      // Models a retained command supported after a consumer upgrade. No editing
      // or version rewriting is part of the operator interface.
      for (let i = 0; i < 2; i++)
        channel.sendToQueue('user.create.failed', body, {
          persistent: true,
          messageId: baseline.commandId,
          correlationId: baseline.correlationId,
          replyTo: replies,
        });
      await channel.waitForConfirms();
      const result = await operate('inspect', '--payload');
      expect(result.code).toBe(0);
      const retained = inspection.parse(JSON.parse(result.stdout)).messages[0];
      expect(retained.eligible).toBe(true);
      const first = await operate('replay', `--message=${retained.receipt}`);
      expect(first.code).toBe(0);
      expect(JSON.parse(first.stdout)).toMatchObject({
        status: 'broker-accepted',
        destination: 'user.create',
        applicationCompleted: false,
      });
      const response = await receive(channel, replies);
      expect(response.properties).toMatchObject({
        messageId: baseline.commandId,
        correlationId: baseline.correlationId,
      });
      expect(JSON.parse(response.content.toString())).toMatchObject({
        commandId: baseline.commandId,
        correlationId: baseline.correlationId,
      });
      expect(
        (await operate('replay', `--message=${retained.receipt}`)).code,
      ).toBe(0);
      expect(
        JSON.parse((await receive(channel, replies)).content.toString()),
      ).toMatchObject({ error: { code: 'USER.ALREADY_EXISTS' } });
      expect(
        (await getHttpServer().get('/v1/users').expect(200)).body,
      ).toMatchObject({ count: 1 });
      expect(
        (await channel.checkQueue('user.create.failed')).messageCount,
      ).toBe(0);
    }, [
      async () => {
        await channel.deleteQueue(replies);
      },
    ]);
  });
}, 30_000);

test('User replay rejects malformed bytes and mismatched identities and retains a missing reply destination', async () => {
  await withCommands(async (channel, replies) => {
    for (const [body, messageId, replyTo] of [
      ['{malformed', baseline.commandId, replies],
      [JSON.stringify(baseline), 'mismatched-id', replies],
      [JSON.stringify(baseline), baseline.commandId, 'missing-reply-queue'],
    ]) {
      channel.sendToQueue('user.create.failed', Buffer.from(body), {
        persistent: true,
        messageId,
        correlationId: baseline.correlationId,
        replyTo,
      });
    }
    await channel.waitForConfirms();
    const retained = inspection.parse(
      JSON.parse((await operate('inspect', '--payload')).stdout),
    );
    expect(retained.messages).toHaveLength(3);
    for (const message of retained.messages) {
      const replay = await operate('replay', `--message=${message.receipt}`);
      expect(replay.code).toBe(message.eligible ? 1 : 2);
    }
    expect((await channel.checkQueue('user.create.failed')).messageCount).toBe(
      3,
    );
    expect(
      (await getHttpServer().get('/v1/users').expect(200)).body,
    ).toMatchObject({ count: 0 });
  });
}, 30_000);

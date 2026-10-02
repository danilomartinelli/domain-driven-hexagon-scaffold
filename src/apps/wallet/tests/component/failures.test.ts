import { expect, test } from 'bun:test';
import { z } from 'zod';
import {
  brokerOptions,
  eventually,
  publish,
  userCreated,
  withBroker,
} from './broker-fixture';
import {
  ownerDatabase,
  startWallet,
  stopWallet,
  walletUrl,
  walletOutput,
} from './wallet-process';
import { brokerGate } from '../../../../../scripts/tests/broker-gate';
import { withCleanup } from '../../../../../scripts/tests/cleanup';

async function operate(...args: string[]) {
  return finish(launch(args));
}

function launch(args: string[], env = process.env) {
  return Bun.spawn(
    [
      process.execPath,
      '--no-env-file',
      'src/apps/wallet/messaging/failures.ts',
      ...args,
    ],
    { stdout: 'pipe', stderr: 'pipe', env },
  );
}

async function finish(child: ReturnType<typeof launch>) {
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

const inspection = z.object({
  queue: z.literal('wallet.user-created.failed'),
  messages: z.array(
    z.object({
      receipt: z.string(),
      messageId: z.string(),
      correlationId: z.string(),
      eligible: z.boolean(),
      contentBase64: z.string().optional(),
    }),
  ),
});

test.each(['malformed', 'unsupported'])(
  'inspection preserves %s bytes and identity; invalid replay stays retained without a Wallet',
  async (kind) => {
    await withBroker(async (channel) => {
      const body =
        kind === 'malformed'
          ? '{malformed-sensitive-payload'
          : userCreated('bad-event', 'bad-user').replace(
              '"version":1',
              '"version":2',
            );
      await publish(channel, body, {
        messageId: 'bad-event',
        correlationId: 'bad-correlation',
      });
      await eventually(async () => {
        expect(
          (await channel.checkQueue('wallet.user-created.failed')).messageCount,
        ).toBe(1);
      });
      const result = await operate('inspect');
      expect(result.code).toBe(0);
      expect(result.stdout).not.toContain(body);
      const output = inspection.parse(JSON.parse(result.stdout));
      expect(output.messages).toHaveLength(1);
      expect(output.messages[0]).toMatchObject({
        messageId: 'bad-event',
        correlationId: 'bad-correlation',
        eligible: false,
      });
      const detailed = await operate('inspect', '--payload');
      expect(detailed.code).toBe(0);
      expect(
        inspection.parse(JSON.parse(detailed.stdout)).messages[0]
          ?.contentBase64,
      ).toBe(Buffer.from(body).toString('base64'));
      const replay = await operate(
        'replay',
        `--message=${output.messages[0]?.receipt}`,
      );
      expect(replay.code).toBe(2);
      expect(JSON.parse(replay.stdout)).toMatchObject({
        status: 'retained',
        reason: 'invalid-or-unsupported-user-created',
      });
      expect(
        (await channel.checkQueue('wallet.user-created.failed')).messageCount,
      ).toBe(1);
      expect(
        (await fetch(`${walletUrl()}/v1/wallets/by-user/bad-event`)).status,
      ).toBe(404);
    });
  },
  30_000,
);

test('eligible retained copies replay unchanged only to Wallet and repeated replay preserves its balance', async () => {
  await withBroker(async (channel) => {
    await stopWallet();
    // Independent retained fixture models a previously rejected version that
    // the installed consumer now supports; replay cannot edit the stored body.
    const body = Buffer.from(userCreated('replay-event', 'replay-user'));
    const properties = {
      persistent: true,
      messageId: 'replay-message',
      correlationId: 'replay-correlation',
      headers: { trace: 'original-trace' },
    };
    channel.sendToQueue('wallet.user-created.failed', Buffer.from('{skip'), {
      persistent: true,
      messageId: 'skip',
      correlationId: 'skip',
    });
    for (let i = 0; i < 2; i++)
      channel.sendToQueue('wallet.user-created.failed', body, properties);
    await channel.waitForConfirms();
    const inspected = await operate('inspect');
    expect(inspected.code).toBe(0);
    const retained = inspection
      .parse(JSON.parse(inspected.stdout))
      .messages.find((message) => message.eligible);
    if (!retained) throw new Error('Missing eligible fixture');
    expect(
      (await operate('replay', `--message=${retained.receipt}`, '--limit=1'))
        .code,
    ).toBe(3);
    expect(
      (await channel.checkQueue('wallet.user-created.failed')).messageCount,
    ).toBe(3);
    const replay = await operate('replay', `--message=${retained.receipt}`);
    expect(replay.code).toBe(0);
    expect(JSON.parse(replay.stdout)).toMatchObject({
      status: 'broker-accepted',
      applicationCompleted: false,
      destination: 'wallet.user-created',
    });
    const delivered = await channel.get('wallet.user-created', {
      noAck: false,
    });
    if (!delivered) throw new Error('Missing replay');
    expect(delivered.content).toEqual(body);
    expect(delivered.properties).toMatchObject({
      messageId: 'replay-message',
      correlationId: 'replay-correlation',
      deliveryMode: 2,
      headers: { trace: 'original-trace' },
    });
    channel.nack(delivered, false, true);
    await startWallet();
    let original: unknown;
    await eventually(async () => {
      const response = await fetch(
        `${walletUrl()}/v1/wallets/by-user/replay-user`,
      );
      expect(response.status).toBe(200);
      original = await response.json();
    });
    await ownerDatabase().query(
      'UPDATE wallets SET balance = 91 WHERE "userId" = $1',
      ['replay-user'],
    );
    expect(
      (await operate('replay', `--message=${retained.receipt}`)).code,
    ).toBe(0);
    await eventually(async () => {
      expect(walletOutput().match(/Wallet event committed/g)?.length).toBe(2);
      expect(
        (await channel.checkQueue('wallet.user-created')).messageCount,
      ).toBe(0);
      expect(
        await (
          await fetch(`${walletUrl()}/v1/wallets/by-user/replay-user`)
        ).json(),
      ).toEqual({
        ...z.object({ id: z.string(), userId: z.string() }).parse(original),
        balance: 91,
      });
    });
    expect(
      (await channel.checkQueue('wallet.user-created.failed')).messageCount,
    ).toBe(1);
    expect(
      (await operate('replay', `--message=${retained.receipt}`)).code,
    ).toBe(3);
  });
}, 30_000);

test.each(['returned', 'nacked'] as const)(
  'a %s replay preserves the retained original',
  async (mode) => {
    await withBroker(async (channel) => {
      await stopWallet();
      channel.sendToQueue(
        'wallet.user-created.failed',
        Buffer.from(userCreated('failed-replay', 'failed-user')),
        {
          persistent: true,
          messageId: 'failed-replay',
          correlationId: 'failed-correlation',
        },
      );
      await channel.waitForConfirms();
      const retained = inspection.parse(
        JSON.parse((await operate('inspect')).stdout),
      ).messages[0];
      await channel.deleteQueue('wallet.user-created');
      await withCleanup(async () => {
        if (mode === 'nacked')
          await channel.assertQueue('wallet.user-created', {
            durable: true,
            arguments: { 'x-max-length': 0, 'x-overflow': 'reject-publish' },
          });
        const replay = await operate('replay', `--message=${retained.receipt}`);
        expect(replay.code).toBe(1);
        expect(
          (await channel.checkQueue('wallet.user-created.failed')).messageCount,
        ).toBe(1);
      }, [
        async () => {
          await channel.deleteQueue('wallet.user-created');
          await channel.assertQueue('wallet.user-created', { durable: true });
        },
      ]);
    });
  },
  30_000,
);

test('inspection and replay reach an eligible delivery beyond a thousand invalid retained messages', async () => {
  await withBroker(async (channel) => {
    await stopWallet();
    for (let i = 0; i < 1000; i++) {
      channel.sendToQueue(
        'wallet.user-created.failed',
        Buffer.from('{invalid-prefix'),
        {
          persistent: true,
          messageId: 'prefix-message',
          correlationId: 'prefix-correlation',
        },
      );
    }
    channel.sendToQueue(
      'wallet.user-created.failed',
      Buffer.from(userCreated('paged-event', 'paged-user')),
      {
        persistent: true,
        messageId: 'paged-message',
        correlationId: 'paged-correlation',
      },
    );
    await channel.waitForConfirms();
    const result = await operate('inspect', '--offset=1000', '--limit=1');
    expect(result.code).toBe(0);
    const page = inspection.parse(JSON.parse(result.stdout));
    expect(page.messages).toHaveLength(1);
    expect(page.messages[0]).toMatchObject({
      messageId: 'paged-message',
      eligible: true,
    });
    expect(
      (await channel.checkQueue('wallet.user-created.failed')).messageCount,
    ).toBe(1001);
    const replay = await operate(
      'replay',
      '--offset=1000',
      '--limit=1',
      `--message=${page.messages[0].receipt}`,
    );
    expect(replay.code).toBe(0);
    expect(
      (await channel.checkQueue('wallet.user-created.failed')).messageCount,
    ).toBe(1000);
    expect((await channel.checkQueue('wallet.user-created')).messageCount).toBe(
      1,
    );
  });
}, 30_000);

test.each(['SIGKILL', 'SIGTERM', 'disconnect', 'timeout'] as const)(
  'unconfirmed replay retains durable ownership after %s',
  async (mode) => {
    await withBroker(async (channel) => {
      await stopWallet();
      channel.sendToQueue(
        'wallet.user-created.failed',
        Buffer.from(userCreated('uncertain-event', 'uncertain-user')),
        {
          persistent: true,
          messageId: 'uncertain-message',
          correlationId: 'uncertain-correlation',
        },
      );
      await channel.waitForConfirms();
      const retained = inspection.parse(
        JSON.parse((await operate('inspect')).stdout),
      ).messages[0];
      const gate = await brokerGate(brokerOptions());
      await withCleanup(async () => {
        gate.allow();
        gate.withholdConfirmations();
        const child = launch(['replay', `--message=${retained.receipt}`], {
          ...process.env,
          RABBITMQ_PORT: gate.port,
        });
        const completed = finish(child);
        await withCleanup(async () => {
          await eventually(async () => {
            expect(gate.confirmations()).toBeGreaterThan(0);
            expect(
              (await channel.checkQueue('wallet.user-created')).messageCount,
            ).toBe(1);
            expect(
              (await channel.checkQueue('wallet.user-created.failed'))
                .messageCount,
            ).toBe(0);
          });
          // The source is unacknowledged, not gone. Losing the process, transport,
          // or confirmation deadline must make the same bytes inspectable again.
          if (mode === 'disconnect') gate.block();
          else if (mode !== 'timeout') child.kill(mode);
          expect((await completed).code).not.toBe(0);
          await eventually(async () => {
            expect(
              (await channel.checkQueue('wallet.user-created.failed'))
                .messageCount,
            ).toBe(1);
          });
          const after = inspection.parse(
            JSON.parse((await operate('inspect')).stdout),
          );
          expect(after.messages[0]?.receipt).toBe(retained.receipt);
          expect(
            (await operate('replay', `--message=${retained.receipt}`)).code,
          ).toBe(0);
          expect(
            (await channel.checkQueue('wallet.user-created')).messageCount,
          ).toBe(2);
          await startWallet();
          await eventually(async () => {
            expect(
              walletOutput().match(/Wallet event committed/g)?.length,
            ).toBe(2);
            expect(
              await (
                await fetch(`${walletUrl()}/v1/wallets/by-user/uncertain-user`)
              ).json(),
            ).toMatchObject({ userId: 'uncertain-user', balance: 0 });
          });
        }, [
          async () => {
            if (child.exitCode === null) child.kill('SIGKILL');
            await completed;
          },
        ]);
      }, [() => gate.close()]);
    });
  },
  45_000,
);

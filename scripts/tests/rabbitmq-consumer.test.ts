import { expect, test } from 'bun:test';
import {
  RabbitConsumer,
  type ConsumerOutcome,
} from '@starter/rabbitmq/consumer';
import { eventually, withRabbitmq } from './rabbitmq-fixture';

test('consumer acknowledges completed work and drains without aborting the accepted handler', async () => {
  await withRabbitmq(
    async ({
      channel,
      gate,
      connection,
      queue,
      failureQueue,
      logger,
      roles,
    }) => {
      const accepted = Promise.withResolvers<AbortSignal>();
      const finish = Promise.withResolvers<ConsumerOutcome>();
      const consumer = new RabbitConsumer({
        connection,
        queue,
        failureQueue,
        prefetch: 1,
        deliveryDeadlineMs: 10_000,
        logger,
        service: 'contract',
        handler: async (_delivery, context) => {
          accepted.resolve(context.signal);
          return finish.promise;
        },
      });
      roles.push(consumer);
      consumer.start();
      consumer.start();
      try {
        await eventually(() => {
          expect(consumer.snapshot().connected).toBe(true);
        });
        channel.sendToQueue(queue, Buffer.from('accepted'), {
          persistent: true,
        });
        await channel.waitForConfirms();
        const signal = await accepted.promise;
        let stopped = false;
        const stop = consumer.stop().then(() => {
          stopped = true;
        });
        await eventually(async () => {
          expect((await channel.checkQueue(queue)).consumerCount).toBe(0);
        });
        expect(consumer.snapshot().connected).toBe(false);
        expect(stopped).toBe(false);
        expect(signal.aborted).toBe(false);
        expect(gate.acknowledgements()).toBe(0);
        finish.resolve({ status: 'completed' });
        await stop;
        expect(signal.aborted).toBe(false);
        expect(gate.acknowledgements()).toBe(1);
        expect(await channel.get(queue, { noAck: true })).toBe(false);
        expect(gate.attempts()).toBe(1);
      } finally {
        finish.resolve({ status: 'completed' });
      }
    },
  );
}, 30_000);

for (const ending of ['stop', 'reconnect'] as const) {
  test(`an expired delivery stays in drain until its real handler settles before ${ending}`, async () => {
    await withRabbitmq(
      async ({
        channel,
        gate,
        connection,
        queue,
        failureQueue,
        logger,
        roles,
      }) => {
        const finish = Promise.withResolvers<undefined>();
        const accepted = Promise.withResolvers<AbortSignal>();
        let calls = 0;
        let active = 0;
        let maximum = 0;
        const redelivered: boolean[] = [];
        const consumer = new RabbitConsumer({
          connection,
          queue,
          failureQueue,
          logger,
          service: 'contract',
          prefetch: 1,
          deliveryDeadlineMs: 100,
          handler: async (delivery, context) => {
            calls++;
            active++;
            maximum = Math.max(maximum, active);
            redelivered.push(delivery.fields.redelivered);
            if (calls === 1) {
              accepted.resolve(context.signal);
              await finish.promise;
            }
            active--;
            return { status: 'completed' };
          },
        });
        roles.push(consumer);
        consumer.start();
        try {
          await eventually(() => {
            expect(consumer.snapshot().connected).toBe(true);
          });
          channel.sendToQueue(queue, Buffer.from('slow'), { persistent: true });
          await channel.waitForConfirms();
          const signal = await accepted.promise;
          await eventually(() => {
            expect(signal.aborted).toBe(true);
          });
          await Bun.sleep(600);
          expect(consumer.snapshot().connected).toBe(false);
          expect(gate.attempts()).toBe(1);
          expect(gate.acknowledgements()).toBe(0);
          expect(active).toBe(1);
          if (ending === 'stop') {
            let stopped = false;
            const stop = consumer.stop().then(() => {
              stopped = true;
            });
            await Bun.sleep(50);
            expect(stopped).toBe(false);
            finish.resolve(undefined);
            await stop;
            const pending = await channel.get(queue, { noAck: true });
            if (!pending) throw new Error('Expired work was acknowledged');
            expect(pending.fields.redelivered).toBe(true);
          } else {
            finish.resolve(undefined);
            await eventually(() => {
              expect(gate.acknowledgements()).toBe(1);
            });
            await consumer.stop();
            expect(redelivered).toEqual([false, true]);
            expect(gate.attempts()).toBe(2);
          }
          expect(active).toBe(0);
          expect(maximum).toBe(1);
        } finally {
          finish.resolve(undefined);
        }
      },
    );
  }, 30_000);
}

test('a reply is confirmed before acknowledgement and preserves its identity', async () => {
  await withRabbitmq(
    async ({
      channel,
      gate,
      connection,
      queue,
      failureQueue,
      logger,
      roles,
    }) => {
      const replies = await channel.assertQueue('', { exclusive: true });
      gate.withholdConfirmations();
      const consumer = new RabbitConsumer({
        connection,
        queue,
        failureQueue,
        logger,
        service: 'contract',
        prefetch: 1,
        deliveryDeadlineMs: 10_000,
        handler: async (delivery, context) => {
          await context.reply(replies.queue, delivery.content, {
            messageId: 'reply-id',
            correlationId: 'reply-correlation',
            contentType: 'application/json',
            type: 'reply',
          });
          return { status: 'completed' };
        },
      });
      roles.push(consumer);
      consumer.start();
      await eventually(() => {
        expect(consumer.snapshot().connected).toBe(true);
      });
      channel.sendToQueue(queue, Buffer.from('{"reply":true}'), {
        persistent: true,
      });
      await channel.waitForConfirms();
      await eventually(() => {
        expect(gate.confirmations()).toBe(1);
      });
      expect(gate.acknowledgements()).toBe(0);
      const reply = await channel.get(replies.queue, { noAck: true });
      if (!reply) throw new Error('Reply was not routed');
      expect(reply.content.toString()).toBe('{"reply":true}');
      expect(reply.properties).toMatchObject({
        messageId: 'reply-id',
        correlationId: 'reply-correlation',
        contentType: 'application/json',
        type: 'reply',
        deliveryMode: 2,
      });
      gate.releaseConfirmations();
      await eventually(() => {
        expect(gate.acknowledgements()).toBe(1);
      });
      await consumer.stop();
      expect(await channel.get(queue, { noAck: true })).toBe(false);
    },
  );
}, 30_000);

test('retention confirms unchanged bytes and metadata without expiration using uniform headers', async () => {
  await withRabbitmq(
    async ({
      channel,
      gate,
      connection,
      queue,
      failureQueue,
      exchange,
      logger,
      records,
      roles,
    }) => {
      gate.withholdConfirmations();
      const consumer = new RabbitConsumer({
        connection,
        queue,
        failureQueue,
        binding: { exchange, routingKey: 'command' },
        logger,
        service: 'contract',
        prefetch: 4,
        deliveryDeadlineMs: 10_000,
        handler: () =>
          Promise.resolve({ status: 'retained', reason: 'invalid-body' }),
      });
      roles.push(consumer);
      consumer.start();
      await eventually(() => {
        expect(consumer.snapshot().connected).toBe(true);
      });
      const body = Buffer.from([0xff, 0x00, 0x7b]);
      channel.publish(exchange, 'command', body, {
        persistent: true,
        messageId: 'poison',
        correlationId: 'correlation',
        replyTo: 'reply-address',
        contentType: 'application/octet-stream',
        contentEncoding: 'binary',
        type: 'probe',
        expiration: '60000',
        headers: {
          custom: 'evidence',
          'x-failure-reason': 'legacy',
          'failure-reason': 'spoofed',
        },
      });
      await channel.waitForConfirms();
      await eventually(() => {
        expect(gate.confirmations()).toBe(1);
      });
      expect(gate.acknowledgements()).toBe(0);
      const retained = await channel.get(failureQueue, { noAck: true });
      if (!retained) throw new Error('Missing retained copy');
      expect(retained.content).toEqual(body);
      expect(retained.properties).toMatchObject({
        messageId: 'poison',
        correlationId: 'correlation',
        replyTo: 'reply-address',
        contentType: 'application/octet-stream',
        contentEncoding: 'binary',
        type: 'probe',
        deliveryMode: 2,
        headers: {
          custom: 'evidence',
          'x-failure-reason': 'legacy',
          'failure-reason': 'invalid-body',
          'original-exchange': exchange,
          'original-routing-key': 'command',
          'original-redelivered': false,
        },
      });
      expect(retained.properties.expiration).toBeUndefined();
      gate.releaseConfirmations();
      await eventually(() => {
        expect(gate.acknowledgements()).toBe(1);
      });
      expect(
        records.find((record) => record.operation === 'consumer.retained'),
      ).toMatchObject({
        operation: 'consumer.retained',
        service: 'contract',
        queue,
        messageId: 'poison',
        reason: 'invalid-body',
      });
    },
  );
}, 30_000);

test('handler failure logs identity and error class only and redelivers before resetting backoff', async () => {
  await withRabbitmq(
    async ({
      channel,
      gate,
      connection,
      queue,
      failureQueue,
      logger,
      records,
      arguments: logged,
      roles,
    }) => {
      let calls = 0;
      const consumer = new RabbitConsumer({
        connection,
        queue,
        failureQueue,
        logger,
        service: 'contract',
        prefetch: 1,
        deliveryDeadlineMs: 10_000,
        handler: (_delivery, context) => {
          context.identify({
            eventId: 'decoded-event',
            correlationId: 'decoded-correlation',
          });
          if (++calls < 3) throw new TypeError('private-payload-and-password');
          return Promise.resolve({ status: 'completed' });
        },
      });
      roles.push(consumer);
      consumer.start();
      await eventually(() => {
        expect(consumer.snapshot().connected).toBe(true);
      });
      channel.sendToQueue(queue, Buffer.from('secret-body'), {
        messageId: 'delivery',
      });
      await channel.waitForConfirms();
      await eventually(() => {
        expect(gate.acknowledgements()).toBe(1);
      });
      expect(
        records
          .filter((record) => record.operation === 'consumer.retry')
          .map((record) => record.retryDelayMs),
      ).toEqual([250, 500]);
      const failures = records.filter(
        (record) => record.operation === 'consumer.failed',
      );
      expect(failures).toHaveLength(2);
      for (const failure of failures)
        expect(failure).toMatchObject({
          service: 'contract',
          queue,
          messageId: 'delivery',
          eventId: 'decoded-event',
          correlationId: 'decoded-correlation',
          errorType: 'TypeError',
        });
      expect(logged.some((value) => value instanceof Error)).toBe(false);
      expect(JSON.stringify(logged)).not.toContain(
        'private-payload-and-password',
      );
      expect(JSON.stringify(logged)).not.toContain('secret-body');
      expect(consumer.snapshot()).toMatchObject({
        connected: true,
        failures: 2,
        retries: 2,
        retryDelayMs: 0,
        lastFailureAt: expect.any(String) as unknown,
      });
      gate.block();
      await eventually(() => {
        expect(consumer.snapshot().retries).toBe(3);
      });
      expect(consumer.snapshot().retryDelayMs).toBe(250);
      gate.allow();
      await eventually(() => {
        expect(consumer.snapshot().connected).toBe(true);
      });
    },
  );
}, 30_000);

for (const fault of [
  'returned reply',
  'missing confirmation',
  'returned retention',
  'missing retention confirmation',
] as const) {
  test(`${fault} ends the consumer session without acknowledging work`, async () => {
    await withRabbitmq(
      async ({
        channel,
        gate,
        connection,
        queue,
        failureQueue,
        logger,
        records,
        roles,
      }) => {
        const replies = await channel.assertQueue('', { exclusive: true });
        if (fault.includes('confirmation')) gate.withholdConfirmations();
        const consumer = new RabbitConsumer({
          connection,
          queue,
          failureQueue,
          logger,
          service: 'contract',
          prefetch: 1,
          deliveryDeadlineMs: 15_000,
          handler: async (delivery, context) => {
            if (fault.includes('retention'))
              return { status: 'retained', reason: 'invalid' };
            await context.reply(
              fault === 'returned reply' ? `${queue}.missing` : replies.queue,
              delivery.content,
            );
            return { status: 'completed' };
          },
        });
        roles.push(consumer);
        consumer.start();
        await eventually(() => {
          expect(consumer.snapshot().connected).toBe(true);
        });
        if (fault === 'returned retention')
          await channel.deleteQueue(failureQueue);
        const started = Date.now();
        channel.sendToQueue(queue, Buffer.from('recoverable'), {
          persistent: true,
        });
        await channel.waitForConfirms();
        await eventually(() => {
          expect(
            records.some((record) => record.operation === 'consumer.failed'),
          ).toBe(true);
        });
        await consumer.stop();
        if (fault.includes('confirmation')) {
          expect(Date.now() - started).toBeGreaterThanOrEqual(4_500);
          expect(Date.now() - started).toBeLessThan(10_000);
        }
        expect(gate.acknowledgements()).toBe(0);
        const pending = await channel.get(queue, { noAck: true });
        if (!pending) throw new Error('Unconfirmed delivery was acknowledged');
        expect(pending.content.toString()).toBe('recoverable');
        expect(pending.fields.redelivered).toBe(true);
      },
    );
  }, 30_000);
}

test('caught reply confirmation failure still ends the session without acknowledging work', async () => {
  await withRabbitmq(
    async ({
      channel,
      gate,
      connection,
      queue,
      failureQueue,
      logger,
      roles,
    }) => {
      const replies = await channel.assertQueue('', { exclusive: true });
      const caught = Promise.withResolvers<AbortSignal>();
      gate.withholdConfirmations();
      const consumer = new RabbitConsumer({
        connection,
        queue,
        failureQueue,
        logger,
        service: 'contract',
        prefetch: 1,
        deliveryDeadlineMs: 15_000,
        handler: async (delivery, context) => {
          try {
            await context.reply(replies.queue, delivery.content);
          } catch {
            caught.resolve(context.signal);
          }
          return { status: 'completed' };
        },
      });
      roles.push(consumer);
      consumer.start();
      await eventually(() => {
        expect(consumer.snapshot().connected).toBe(true);
      });
      channel.sendToQueue(queue, Buffer.from('recoverable'), {
        persistent: true,
      });
      await channel.waitForConfirms();
      const signal = await caught.promise;
      await consumer.stop();
      expect(signal.aborted).toBe(true);
      expect(gate.acknowledgements()).toBe(0);
      const pending = await channel.get(queue, { noAck: true });
      if (!pending) throw new Error('Unconfirmed delivery was acknowledged');
      expect(pending.content.toString()).toBe('recoverable');
      expect(pending.fields.redelivered).toBe(true);
    },
  );
}, 30_000);

test('broker loss aborts accepted work but reconnection and stop await the real handler', async () => {
  await withRabbitmq(
    async ({
      channel,
      gate,
      connection,
      queue,
      failureQueue,
      logger,
      roles,
    }) => {
      const accepted = Promise.withResolvers<AbortSignal>();
      const finish = Promise.withResolvers<undefined>();
      const consumer = new RabbitConsumer({
        connection,
        queue,
        failureQueue,
        logger,
        service: 'contract',
        prefetch: 1,
        deliveryDeadlineMs: 10_000,
        handler: async (_delivery, context) => {
          accepted.resolve(context.signal);
          await finish.promise;
          return { status: 'completed' };
        },
      });
      roles.push(consumer);
      consumer.start();
      try {
        await eventually(() => {
          expect(consumer.snapshot().connected).toBe(true);
        });
        channel.sendToQueue(queue, Buffer.from('session-loss'), {
          persistent: true,
        });
        await channel.waitForConfirms();
        const signal = await accepted.promise;
        gate.block();
        await eventually(() => {
          expect(signal.aborted).toBe(true);
        });
        gate.allow();
        await Bun.sleep(600);
        expect(gate.attempts()).toBe(1);
        let stopped = false;
        const stop = consumer.stop().then(() => {
          stopped = true;
        });
        await Bun.sleep(50);
        expect(stopped).toBe(false);
        finish.resolve(undefined);
        await stop;
        expect(gate.acknowledgements()).toBe(0);
        const pending = await channel.get(queue, { noAck: true });
        if (!pending) throw new Error('Disconnected delivery was lost');
        expect(pending.fields.redelivered).toBe(true);
      } finally {
        finish.resolve(undefined);
      }
    },
  );
}, 30_000);

test('broker cancellation reconnects and restores the declared subscription', async () => {
  await withRabbitmq(
    async ({
      channel,
      gate,
      connection,
      queue,
      failureQueue,
      logger,
      roles,
    }) => {
      const consumer = new RabbitConsumer({
        connection,
        queue,
        failureQueue,
        logger,
        service: 'contract',
        prefetch: 4,
        deliveryDeadlineMs: 10_000,
        handler: () => Promise.resolve({ status: 'completed' }),
      });
      roles.push(consumer);
      consumer.start();
      await eventually(() => {
        expect(consumer.snapshot().connected).toBe(true);
      });
      await channel.deleteQueue(queue);
      await eventually(() => {
        expect(gate.attempts()).toBe(2);
        expect(consumer.snapshot().connected).toBe(true);
      });
      channel.sendToQueue(queue, Buffer.from('restored'));
      await channel.waitForConfirms();
      await eventually(() => {
        expect(gate.acknowledgements()).toBe(1);
      });
    },
  );
}, 30_000);

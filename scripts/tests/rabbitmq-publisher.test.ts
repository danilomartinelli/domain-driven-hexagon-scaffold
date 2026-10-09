import { expect, test } from 'bun:test';
import { RabbitPublisher } from '@starter/rabbitmq/publisher';
import { eventually, withRabbitmq } from './rabbitmq-fixture';

test('publisher stop drains a claim that begins publishing after shutdown and waits for confirmation', async () => {
  await withRabbitmq(
    async ({ channel, gate, connection, queue, exchange, logger, roles }) => {
      const claimed = Promise.withResolvers<undefined>();
      const begin = Promise.withResolvers<undefined>();
      let calls = 0;
      let completed = false;
      gate.withholdConfirmations();
      const publisher = new RabbitPublisher({
        connection,
        exchange,
        routingKey: 'event',
        queues: [queue],
        logger,
        service: 'contract',
        claim: async (publish) => {
          calls++;
          claimed.resolve(undefined);
          await begin.promise;
          await publish({
            body: Buffer.from('accepted'),
            messageId: 'event',
            correlationId: 'trace',
            contentType: 'application/json',
            type: 'created',
          });
          completed = true;
          return true;
        },
      });
      roles.push(publisher);
      publisher.start();
      publisher.start();
      try {
        await claimed.promise;
        expect(publisher.snapshot().connected).toBe(true);
        let stopped = false;
        const stop = publisher.stop().then(() => {
          stopped = true;
        });
        expect(publisher.snapshot().connected).toBe(false);
        await Bun.sleep(50);
        expect(stopped).toBe(false);
        begin.resolve(undefined);
        await eventually(() => {
          expect(gate.confirmations()).toBe(1);
        });
        expect(completed).toBe(false);
        expect(stopped).toBe(false);
        const message = await channel.get(queue, { noAck: true });
        if (!message) throw new Error('Missing accepted publication');
        expect(message.content.toString()).toBe('accepted');
        expect(message.properties).toMatchObject({
          messageId: 'event',
          correlationId: 'trace',
          contentType: 'application/json',
          type: 'created',
          deliveryMode: 2,
        });
        gate.releaseConfirmations();
        await stop;
        expect(completed).toBe(true);
        expect(calls).toBe(1);
        expect(gate.attempts()).toBe(1);
      } finally {
        begin.resolve(undefined);
        gate.releaseConfirmations();
      }
    },
  );
}, 30_000);

test('publisher preserves body bytes and omits only identities beyond 255 UTF-8 bytes', async () => {
  await withRabbitmq(
    async ({ channel, connection, queue, exchange, logger, roles }) => {
      const identities = [
        'a'.repeat(255),
        'a'.repeat(256),
        'é'.repeat(127) + 'a',
        'é'.repeat(128),
      ];
      let next = 0;
      const publisher = new RabbitPublisher({
        connection,
        exchange,
        routingKey: 'event',
        queues: [queue],
        logger,
        service: 'contract',
        claim: async (publish) => {
          const id = identities.at(next);
          if (id === undefined) return false;
          await publish({
            body: Buffer.from(
              JSON.stringify({ eventId: id, correlationId: id }),
            ),
            messageId: id,
            correlationId: id,
          });
          next++;
          return true;
        },
      });
      roles.push(publisher);
      publisher.start();
      await eventually(() => {
        expect(next).toBe(identities.length);
      });
      await publisher.stop();
      for (const id of identities) {
        const message = await channel.get(queue, { noAck: true });
        if (!message) throw new Error('Missing identity publication');
        expect(message.content).toEqual(
          Buffer.from(JSON.stringify({ eventId: id, correlationId: id })),
        );
        const property = Buffer.byteLength(id, 'utf8') <= 255 ? id : undefined;
        expect(message.properties.messageId).toBe(property);
        expect(message.properties.correlationId).toBe(property);
      }
    },
  );
}, 30_000);

for (const fault of ['return', 'missing confirmation'] as const) {
  test(`publisher ${fault} leaves the claim incomplete and logs identity without raw errors`, async () => {
    await withRabbitmq(
      async ({
        channel,
        gate,
        connection,
        queue,
        exchange,
        logger,
        records,
        arguments: logged,
        roles,
      }) => {
        const claimed = Promise.withResolvers<undefined>();
        const begin = Promise.withResolvers<undefined>();
        let completed = false;
        const publisher = new RabbitPublisher({
          connection,
          exchange,
          routingKey: 'event',
          queues: [queue],
          logger,
          service: 'contract',
          claim: async (publish) => {
            claimed.resolve(undefined);
            await begin.promise;
            await publish({
              body: Buffer.from('private-body'),
              messageId: 'event-id',
              correlationId: 'correlation-id',
            });
            completed = true;
            return true;
          },
        });
        roles.push(publisher);
        publisher.start();
        try {
          await claimed.promise;
          if (fault === 'return')
            await channel.unbindQueue(queue, exchange, 'event');
          else gate.withholdConfirmations();
          // Stop prevents a second claim while the first publication remains uncertain.
          const stop = publisher.stop();
          begin.resolve(undefined);
          await stop;
          expect(completed).toBe(false);
          const failures = records.filter(
            (record) => record.operation === 'publisher.failed',
          );
          expect(failures).toHaveLength(1);
          expect(failures[0]).toMatchObject({
            service: 'contract',
            exchange,
            eventId: 'event-id',
            messageId: 'event-id',
            correlationId: 'correlation-id',
            errorType: 'Error',
            retryDelayMs: 250,
          });
          expect(logged.some((value) => value instanceof Error)).toBe(false);
          expect(JSON.stringify(logged)).not.toContain('private-body');
          expect(publisher.snapshot().connected).toBe(false);
        } finally {
          begin.resolve(undefined);
        }
      },
    );
  }, 30_000);
}

test('publisher failure identity follows each claim and retry backoff resets only after completed work', async () => {
  await withRabbitmq(
    async ({
      channel,
      gate,
      connection,
      queue,
      exchange,
      logger,
      records,
      arguments: logged,
      roles,
    }) => {
      let calls = 0;
      const id = 'é'.repeat(128);
      const publisher = new RabbitPublisher({
        connection,
        exchange,
        routingKey: 'event',
        queues: [queue],
        logger,
        service: 'contract',
        claim: async (publish) => {
          calls++;
          if (calls === 1) throw new TypeError('private-selection-detail');
          if (calls === 2) {
            await publish({
              body: Buffer.from('private-envelope'),
              messageId: id,
              correlationId: id,
            });
            throw new RangeError('private-completion-detail');
          }
          if (calls === 3) return true;
          if (calls === 4) throw new TypeError('private-next-selection');
          return false;
        },
      });
      roles.push(publisher);
      publisher.start();
      await eventually(() => {
        expect(calls).toBeGreaterThanOrEqual(5);
      });
      const failures = records.filter(
        (record) => record.operation === 'publisher.failed',
      );
      expect(failures).toHaveLength(3);
      expect(failures.map((record) => record.retryDelayMs)).toEqual([
        250, 500, 250,
      ]);
      expect(failures[0]).not.toHaveProperty('messageId');
      expect(failures[0]).not.toHaveProperty('eventId');
      expect(failures[1]).toMatchObject({
        messageId: id,
        eventId: id,
        correlationId: id,
        errorType: 'RangeError',
      });
      expect(failures[2]).not.toHaveProperty('eventId');
      expect(failures[2]).not.toHaveProperty('correlationId');
      expect(JSON.stringify(logged)).not.toContain('private-');
      expect(logged.some((value) => value instanceof Error)).toBe(false);
      const message = await channel.get(queue, { noAck: true });
      if (!message)
        throw new Error('Missing confirmed event before completion failure');
      expect(message.properties.messageId).toBeUndefined();
      expect(publisher.snapshot()).toMatchObject({
        connected: true,
        retries: 3,
        failures: 3,
        retryDelayMs: 0,
        lastFailureAt: expect.any(String) as unknown,
      });
      gate.block();
      await eventually(() => {
        expect(publisher.snapshot().retries).toBe(4);
      });
      // Empty claims and successful connections cannot reset the retry delay.
      expect(publisher.snapshot().retryDelayMs).toBe(500);
      gate.allow();
      await eventually(() => {
        expect(publisher.snapshot().connected).toBe(true);
      });
    },
  );
}, 30_000);

test('a confirmed claim completed after broker loss resets reconnection backoff', async () => {
  await withRabbitmq(
    async ({ gate, connection, queue, exchange, logger, roles }) => {
      const confirmed = Promise.withResolvers<undefined>();
      const finish = Promise.withResolvers<undefined>();
      let calls = 0;
      const publisher = new RabbitPublisher({
        connection,
        exchange,
        routingKey: 'event',
        queues: [queue],
        logger,
        service: 'contract',
        claim: async (publish) => {
          calls++;
          if (calls === 1) throw new Error('Selection failed');
          if (calls !== 2) return false;
          await publish({ body: Buffer.from('confirmed'), messageId: 'event' });
          confirmed.resolve(undefined);
          await finish.promise;
          return true;
        },
      });
      roles.push(publisher);
      publisher.start();
      try {
        await confirmed.promise;
        gate.block();
        await eventually(() => {
          expect(publisher.snapshot().connected).toBe(false);
        });
        finish.resolve(undefined);
        await eventually(() => {
          expect(publisher.snapshot().retries).toBe(2);
        });
        expect(publisher.snapshot().retryDelayMs).toBe(250);
        gate.allow();
        await eventually(() => {
          expect(publisher.snapshot().connected).toBe(true);
        });
      } finally {
        finish.resolve(undefined);
      }
    },
  );
}, 30_000);

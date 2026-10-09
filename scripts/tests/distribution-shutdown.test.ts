import { expect, test as bunTest } from 'bun:test';
import { availablePort } from '../lib/environments';
import { runCommand } from '../lib/command';
import { readEnvironmentFile } from '../../database/environment';
import { withDistribution, until } from './distribution-fixture';

const test = bunTest.skipIf(
  !process.env.DDH_VALIDATED_IMAGE && !process.env.DDH_IMAGE_PLATFORM,
);

test('container stop drains accepted work or rolls it back at the deadline and recovers on restart', async () => {
  await withDistribution(
    'user',
    async ({ owner, http, start, stop, probe, databaseFault, migrate }) => {
      if (!probe || !databaseFault)
        throw new Error('This lifecycle check requires an OCI image');
      await owner.query(
        'BEGIN; LOCK TABLE pgmigrations IN ACCESS EXCLUSIVE MODE',
      );
      try {
        expect((await migrate('status')).code).toBe(124);
        const manifest = readEnvironmentFile(
          process.env.DDH_ENVIRONMENT_FILE ?? '',
        );
        const remaining = await runCommand(
          [
            'docker',
            'ps',
            '-a',
            '--filter',
            `label=dev.starter.owner=${manifest.owner}`,
            '--format',
            '{{.Names}}',
          ],
          { cwd: process.cwd() },
        );
        expect(remaining.code, remaining.stderr).toBe(0);
        expect(remaining.stdout.trim().split('\n')).toHaveLength(3);
      } finally {
        await owner.query('ROLLBACK');
      }
      expect((await migrate('status')).code).toBe(0);
      await start({ RABBITMQ_PORT: String(await availablePort()) });
      await databaseFault('pause');
      try {
        await until(
          async () => (await probe('/health/ready/http')).status === 503,
        );
        await until(async () => (await http.get('/v1/users')).status === 503);
        expect((await probe('/health/live')).status).toBe(200);
      } finally {
        await databaseFault('unpause');
      }
      await until(async () => (await http.get('/v1/users')).status === 200);
      await stop();
      for (const mode of ['drain', 'timeout']) {
        const unavailable = { RABBITMQ_PORT: String(await availablePort()) };
        await start(unavailable);
        await owner.query(
          'BEGIN; SET LOCAL stats_fetch_consistency = none; LOCK TABLE users IN ACCESS EXCLUSIVE MODE',
        );
        let stopResult: Promise<void> | undefined;
        let paused = false;
        const request = http
          .post('/v1/users')
          .send({
            email: 'container-drain@example.com',
            country: 'England',
            street: 'Baker street',
            postalCode: 'NW16XE',
          })
          .then(
            (response) => response.status,
            () => 0,
          );
        try {
          await until(async () => {
            await owner.query('SELECT pg_stat_clear_snapshot()');
            return (
              (
                await owner.query(
                  "SELECT pid FROM pg_stat_activity WHERE usename = 'user_runtime' AND wait_event_type = 'Lock' AND query ILIKE '%users%'",
                )
              ).rows.length > 0
            );
          });
          if (mode === 'timeout') {
            await databaseFault('pause');
            paused = true;
          }
          const started = Date.now();
          stopResult = stop(mode === 'timeout' ? 1 : 0);
          await until(
            async () =>
              (await probe('/health/ready')).body !== undefined &&
              (await probe('/health/ready/http')).status === 503,
          );
          expect((await probe('/health/live')).status).toBe(200);
          expect(
            (
              await http.post('/v1/users').send({
                email: 'refused@example.com',
                country: 'England',
                street: 'Baker street',
                postalCode: 'NW16XE',
              })
            ).status,
          ).toBe(503);
          if (mode === 'drain') {
            await owner.query('COMMIT');
            expect(await request).toBe(201);
          }
          await stopResult;
          if (mode === 'timeout') {
            expect(Date.now() - started).toBeGreaterThanOrEqual(14_000);
            expect(Date.now() - started).toBeLessThan(20_000);
            await databaseFault('unpause');
            paused = false;
            await request;
            await owner.query('ROLLBACK');
          }
          const before = await owner.query('SELECT id FROM users');
          expect(before.rows).toHaveLength(mode === 'drain' ? 1 : 0);
          expect(
            (
              await owner.query(
                'SELECT event_id FROM user_outbox WHERE published_at IS NULL',
              )
            ).rows,
          ).toHaveLength(before.rows.length);
          await start(unavailable);
          expect((await http.get('/v1/users').expect(200)).body).toMatchObject({
            count: before.rows.length,
          });
          if (mode === 'timeout')
            await http
              .post('/v1/users')
              .send({
                email: 'container-drain@example.com',
                country: 'England',
                street: 'Baker street',
                postalCode: 'NW16XE',
              })
              .expect(201);
          expect(
            (
              await owner.query(
                'SELECT event_id FROM user_outbox WHERE published_at IS NULL',
              )
            ).rows,
          ).toHaveLength(1);
        } finally {
          if (paused) await databaseFault('unpause');
          await owner.query('ROLLBACK');
          await request;
          await stopResult;
        }
        await stop();
        await owner.query('TRUNCATE users, user_outbox');
      }
    },
  );
}, 360_000);

import { expect, test } from 'bun:test';
import { rejects } from 'node:assert/strict';
import { sql } from 'slonik';
import { z } from 'zod';
import { withCleanup } from '../../scripts/tests/cleanup';
import {
  docker,
  ownedContainer,
  withServiceFault,
} from '@tests/setup/operations';
import { getTestDatabase, getWalletDatabase } from '@tests/setup/test-server';

test('stopping tmpfs requires explicit data-loss intent before the scenario runs', async () => {
  for (const service of ['postgres-user', 'postgres-wallet', 'rabbitmq']) {
    const container = await ownedContainer(service);
    let ran = false;
    await rejects(
      withServiceFault({ service, mode: 'stopped' }, () => {
        ran = true;
      }),
      /Stopping tmpfs loses data/,
    );
    expect(ran).toBe(false);
    expect(
      await docker([
        'inspect',
        '--format',
        '{{.State.Running}} {{.State.Paused}}',
        container,
      ]),
    ).toBe('true false');
  }
});

test('unresponsive database faults preserve existing rows and restore service after success or failure', async () => {
  for (const [service, pool] of [
    ['postgres-user', getTestDatabase()],
    ['postgres-wallet', getWalletDatabase()],
  ] as const) {
    const container = await ownedContainer(service);
    await pool.query(
      sql.unsafe`CREATE TABLE service_fault_probe (marker text)`,
    );
    await withCleanup(async () => {
      await pool.query(
        sql.unsafe`INSERT INTO service_fault_probe VALUES ('preserved')`,
      );
      for (const fail of [false, true]) {
        const failure = new Error('scenario failed while database was paused');
        const operation = withServiceFault(
          { service, mode: 'unresponsive' },
          async () => {
            expect(
              await docker([
                'inspect',
                '--format',
                '{{.State.Paused}}',
                container,
              ]),
            ).toBe('true');
            if (fail) throw failure;
            return 'completed';
          },
        );
        if (fail) await rejects(operation, (error) => error === failure);
        else expect(await operation).toBe('completed');
        expect(
          await docker(['inspect', '--format', '{{.State.Paused}}', container]),
        ).toBe('false');
        expect(
          await pool.oneFirst(
            sql.type(
              z.object({ marker: z.string() }),
            )`SELECT marker FROM service_fault_probe`,
          ),
        ).toBe('preserved');
      }
    }, [() => pool.query(sql.unsafe`DROP TABLE service_fault_probe`)]);
  }
}, 30_000);

test('faults reject unknown services and leave an already paused container alone', async () => {
  await rejects(
    withServiceFault(
      { service: 'unknown-service', mode: 'unresponsive' },
      () => {
        throw new Error('must not run');
      },
    ),
    /Expected one owned container/,
  );
  const container = await ownedContainer('postgres-user');
  await withCleanup(async () => {
    await docker(['pause', container]);
    await rejects(
      withServiceFault(
        { service: 'postgres-user', mode: 'unresponsive' },
        () => {
          throw new Error('must not run');
        },
      ),
      /Expected a running, unpaused container/,
    );
    expect(
      await docker(['inspect', '--format', '{{.State.Paused}}', container]),
    ).toBe('true');
  }, [() => docker(['unpause', container])]);
});

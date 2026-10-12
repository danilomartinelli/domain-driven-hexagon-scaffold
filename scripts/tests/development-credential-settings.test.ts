import { expect, test } from 'bun:test';
import {
  capabilityCases,
  rendererFixture,
  withShell,
} from './environment-renderer-fixture';

test('development containers preserve both credential sources for runtime validation', () =>
  withShell(
    {
      ORDER_HISTORY_DB_PASSWORD_FILE: '/explicit-database-password',
      RABBITMQ_PASSWORD_FILE: '/explicit-broker-password',
    },
    async () => {
      const fixture = await rendererFixture();
      try {
        const manifest = await fixture.manifest('development', [
          capabilityCases[7],
        ]);
        expect(
          fixture.applicationContainer(manifest, 'order-history').environment,
        ).toMatchObject({
          ORDER_HISTORY_DB_PASSWORD: "runtime'$$fixture",
          ORDER_HISTORY_DB_PASSWORD_FILE: '/explicit-database-password',
          RABBITMQ_PASSWORD: 'broker/$$fixture',
          RABBITMQ_PASSWORD_FILE: '/explicit-broker-password',
        });
      } finally {
        await fixture.cleanup();
      }
    },
  ));

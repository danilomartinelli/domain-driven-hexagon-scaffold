import { afterAll, beforeAll, expect, test } from 'bun:test';
import { operationsCompose } from '../lib/operations-compose';
import { requiredServices } from '../lib/operations-plan';
import {
  capabilityCases,
  rendererFixture,
  imageSettings,
  selection,
  withProcesses,
  withShell,
} from './environment-renderer-fixture';

function composeServices(command: string[], action: 'up' | 'stop'): string[] {
  return command
    .slice(command.indexOf(action) + 1)
    .filter(
      (argument) =>
        argument === 'rabbitmq' ||
        argument === 'gateway' ||
        argument.startsWith('postgres-'),
    );
}

let fixture: Awaited<ReturnType<typeof rendererFixture>>;
beforeAll(async () => {
  fixture = await rendererFixture();
});
afterAll(async () => {
  await fixture.cleanup();
});

for (const app of capabilityCases) {
  const capabilities = `persistence=${String(app.persistence)}, messaging=${String(app.messaging)}, exposure=${String(app.exposure)}`;
  test(`prepared Compose documents preserve ${capabilities}`, () =>
    withShell({}, async () => {
      const development = await fixture.manifest('development', [app]);
      const testing = await fixture.manifest('test', [app]);
      expect(
        fixture.normalize(
          {
            development: fixture.composeConfiguration(development),
            shutdown: fixture.composeConfiguration(development, {
              shutdown: true,
            }),
          },
          development,
        ),
      ).toMatchSnapshot();
      expect(
        fixture.normalize(
          {
            test: fixture.composeConfiguration(testing),
            shutdown: fixture.composeConfiguration(testing, { shutdown: true }),
          },
          testing,
        ),
      ).toMatchSnapshot();
    }));

  test(`Compose reference and deployment services preserve ${capabilities}`, () => {
    const installation = fixture.installation([app]);
    expect(operationsCompose(installation, false)).toMatchSnapshot();
    expect(
      Object.fromEntries(requiredServices(installation.applied.applications)),
    ).toMatchSnapshot();
  });

  test(`host and development container settings preserve ${capabilities}`, () =>
    withShell({}, async () => {
      const development = await fixture.manifest('development', [app]);
      const testing = await fixture.manifest('test', [app]);
      expect(
        fixture.normalize(
          {
            developmentHost: fixture.environmentVariables(development, {}),
            testHost: fixture.normalize(
              fixture.environmentVariables(testing, {}),
              testing,
            ),
            container: fixture.applicationContainer(development, app.name)
              .environment,
          },
          development,
        ),
      ).toMatchSnapshot();
    }));

  test(`platform image runtime and migration settings preserve ${capabilities}`, () =>
    withShell({}, async () => {
      const manifest = await fixture.manifest('development', [app]);
      const settings = await imageSettings(fixture, {
        app,
        manifest,
        image: 'fixture-image',
        platform: 'linux/arm64',
      });
      expect(fixture.normalize(settings, manifest)).toMatchSnapshot();
      if (app.messaging) {
        expect(settings.runtime).toHaveProperty(
          'RABBITMQ_MANAGEMENT_URL',
          'http://127.0.0.1:25672',
        );
        expect(
          fixture.applicationContainer(manifest, app.name).environment,
        ).not.toHaveProperty('RABBITMQ_MANAGEMENT_URL');
      }
    }));
}

test('multiple applications preserve prefix ownership, retained databases and shell overrides', () =>
  withShell(
    {
      NODE_ENV: 'custom-development',
      ORDER_HTTP_PORT: '4100',
      ORDER_DB_HOST: 'external-db',
      ORDER_DB_PORT: '5544',
      ORDER_DB_PASSWORD: 'override-$fixture',
      ORDER_RABBITMQ_URL: 'amqp://explicit/$fixture',
      RABBITMQ_HOST: 'external-broker',
      RABBITMQ_PORT: '5679',
      ORDER_CUSTOM: 'short-$fixture',
      ORDER_HISTORY_CUSTOM: 'long-$fixture',
      ORDER_HISTORY_DB_PASSWORD: 'explicit-disabled-$fixture',
      ORDER_DB_MIGRATION_PASSWORD: 'never-in-runtime',
      UNRELATED_CUSTOM: 'never-in-container',
    },
    async () => {
      const manifest = await fixture.manifest('development', selection, true);
      expect(
        fixture.normalize(
          {
            host: fixture.environmentVariables(manifest),
            compose: fixture.composeConfiguration(manifest),
            shutdown: fixture.composeConfiguration(manifest, {
              shutdown: true,
            }),
            watch: fixture.applicationContainer(manifest, 'order'),
            debug: fixture.applicationContainer(
              manifest,
              'order-history',
              'debug',
              6501,
            ),
            serve: fixture.applicationContainer(
              manifest,
              'order-history',
              'serve',
            ),
          },
          manifest,
        ),
      ).toMatchSnapshot();
      const installation = fixture.installation(selection);
      expect(operationsCompose(installation, false)).toMatchSnapshot();
      expect(
        Object.fromEntries(requiredServices(installation.applied.applications)),
      ).toMatchSnapshot();
    },
  ));

test('platform image settings preserve multiple selections with retained infrastructure', () =>
  withShell(
    {
      ORDER_HTTP_PORT: 'ignored-shell-port',
      RABBITMQ_HOST: 'ignored-shell-host',
    },
    async () => {
      const manifest = await fixture.manifest('development', selection, true);
      const settings: Record<string, unknown> = {};
      for (const app of selection)
        settings[app.name] = await imageSettings(fixture, {
          app,
          manifest,
          image: 'fixture-image',
          platform: 'linux/arm64',
        });
      expect(fixture.normalize(settings, manifest)).toMatchSnapshot();
    },
  ));

for (const perCommand of [false, true]) {
  test(`platform image settings preserve explicit runtime and migration overrides (per-command=${String(perCommand)})`, () =>
    withShell({}, async () => {
      const app = capabilityCases[7];
      const manifest = await fixture.manifest('development', [app]);
      const settings = await imageSettings(
        fixture,
        {
          app,
          manifest,
          image: 'fixture-image',
          platform: 'linux/arm64',
          runtime: {
            PATH: '/never-pass',
            NODE_ENV: 'custom-runtime',
            ORDER_HISTORY_DB_HOST: 'runtime-option-host',
            ORDER_HISTORY_DB_PORT: '5544',
            ORDER_HISTORY_DB_USERNAME: 'runtime-option-user',
            ORDER_HISTORY_DB_PASSWORD: 'runtime-option-$password',
            ORDER_HISTORY_HTTP_PORT: '4100',
            ORDER_HISTORY_CUSTOM: 'runtime-$custom',
            RABBITMQ_HOST: 'runtime-option-broker',
            ORDER_HISTORY_RABBITMQ_URL: 'amqp://runtime-option',
          },
          migration: {
            PATH: '/never-pass',
            NODE_ENV: 'custom-migration',
            ORDER_HISTORY_DB_HOST: 'migration-option-host',
            ORDER_HISTORY_DB_PORT: '5545',
            ORDER_HISTORY_DB_MIGRATION_USERNAME: 'migration-option-user',
            ORDER_HISTORY_DB_MIGRATION_PASSWORD: 'migration-option-$password',
            ORDER_HISTORY_CUSTOM: 'migration-$custom',
            RABBITMQ_HOST: 'migration-option-broker',
          },
        },
        perCommand
          ? {
              runtime: {
                ORDER_HISTORY_DB_HOST: 'runtime-command-host',
                ORDER_HISTORY_DB_PORT: '6544',
                ORDER_HISTORY_CUSTOM: 'runtime-command-$custom',
                RABBITMQ_HOST: 'runtime-command-broker',
                ORDER_HISTORY_RABBITMQ_URL: 'amqp://runtime-command',
              },
              migration: {
                ORDER_HISTORY_DB_HOST: 'migration-command-host',
                ORDER_HISTORY_DB_PORT: '6545',
                ORDER_HISTORY_CUSTOM: 'migration-command-$custom',
                RABBITMQ_HOST: 'migration-command-broker',
              },
            }
          : {},
      );
      expect(fixture.normalize(settings, manifest)).toMatchSnapshot();
    }));
}

for (const apps of [...capabilityCases.map((app) => [app]), selection]) {
  test(`development reconciliation selects active and inactive services for ${JSON.stringify(apps)}`, () =>
    withShell({}, async () => {
      const manifest = await fixture.manifest('development', apps, true);
      const services = { active: [] as string[], inactive: [] as string[] };
      await withProcesses(
        (command) => {
          if (
            command[0] === process.execPath &&
            command[2] === 'scripts/reconcile-databases.ts'
          )
            return {};
          if (command[0] !== 'docker') throw new Error('Unexpected process');
          if (command[1] === 'compose') {
            const up = command.indexOf('up');
            const stop = command.indexOf('stop');
            if (up >= 0)
              services.active.push(...composeServices(command, 'up'));
            else if (stop >= 0)
              services.inactive.push(...composeServices(command, 'stop'));
            else throw new Error('Unexpected Compose operation');
          } else if (!(
            command[1] === 'ps' || ['network', 'volume'].includes(command[1])
          ))
            throw new Error('Unexpected Docker operation');
          return {};
        },
        async () => {
          expect(
            await fixture.operateEnvironment(
              'prepare',
              'development',
              manifest.run,
              [],
              apps.map((app) => app.name),
            ),
          ).toBe(0);
        },
      );
      // Observe the selected services at the Compose boundary, without pinning call order.
      expect({
        active: services.active.sort(),
        inactive: services.inactive.sort(),
      }).toMatchSnapshot();
    }));
}

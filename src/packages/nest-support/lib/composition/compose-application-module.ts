import {
  Module,
  type DynamicModule,
  type InjectionToken,
} from '@nestjs/common';
import { readApplicationDeclaration } from '@starter/capabilities/declaration';
import {
  composeApplication,
  readApplicationComposition,
} from '@starter/capabilities/composition';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { HealthController } from '../operations/health.controller';
import { ServiceHealth } from '../operations/service-health';
import {
  ApplicationReadiness,
  MESSAGE_HANDLERS,
} from './application-readiness';
import { ApplicationLifecycle } from './application-lifecycle';
import type {
  ApplicationFactories,
  ApplicationPart,
  BacklogSource,
  DatabaseProbe,
  MessagingRole,
  PersistencePart,
} from './parts';

const BACKLOG = Symbol('BACKLOG');
const DATABASE_PROBE = Symbol('DATABASE_PROBE');
const CONSUMER = Symbol('CONSUMER');
const PUBLISHER = Symbol('PUBLISHER');

@Module({})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- Nest requires a module class.
class ApplicationModule {}

export async function composeApplicationModule(
  directory: string | URL,
  factories: ApplicationFactories,
): Promise<DynamicModule> {
  const path =
    typeof directory === 'string' ? directory : fileURLToPath(directory);
  const declaration = readApplicationDeclaration(
    join(path, 'application.json'),
  );
  // Defer evaluation so compatibility and the entire binding are checked first.
  type SelectedFactory = {
    persistence: boolean;
    create: () =>
      | ApplicationPart
      | PersistencePart
      | Promise<ApplicationPart | PersistencePart>;
  };
  const selected = composeApplication<SelectedFactory>(
    declaration,
    readApplicationComposition(path),
    {
      integrations: Object.fromEntries(
        Object.entries(factories.integrations).map(([name, create]) => [
          name,
          () => ({ persistence: name === 'persistence', create }),
        ]),
      ),
      groups: Object.fromEntries(
        Object.entries(factories.groups).map(([name, create]) => [
          name,
          () => ({ persistence: false, create }),
        ]),
      ),
    },
  );
  const parts: (ApplicationPart | PersistencePart)[] = [];
  for (const factory of selected) {
    const part = await factory.create();
    if (factory.persistence !== Boolean(part.database))
      throw new Error(
        `${declaration.name}: only the persistence integration must supply a database probe`,
      );
    parts.push(part);
  }
  const database = parts.find((part) => part.database)?.database;
  if (declaration.persistence !== Boolean(database))
    throw new Error(
      `${declaration.name}: supply a database probe exactly when persistence is enabled`,
    );
  const roles: {
    name: 'consumer' | 'publisher';
    token: InjectionToken<MessagingRole>;
  }[] = [];
  for (const part of parts) {
    for (const name of Object.keys(part)) {
      if (name !== 'consumer' && name !== 'publisher') continue;
      const token = part[name];
      if (token === undefined) continue;
      const declared = part.providers?.some(
        (provider) =>
          (typeof provider === 'function' ? provider : provider.provide) ===
          token,
      );
      if (!declared)
        throw new Error(
          `${declaration.name}: ${name} must name a provider declared by its part`,
        );
      roles.push({ name, token });
    }
  }
  for (const name of ['consumer', 'publisher'] as const)
    if (roles.filter((role) => role.name === name).length > 1)
      throw new Error(`${declaration.name}: register at most one ${name}`);
  if (declaration.messaging !== roles.length > 0)
    throw new Error(
      `${declaration.name}: register a messaging role exactly when messaging is enabled`,
    );
  const consumer = roles.find((role) => role.name === 'consumer')?.token;
  const publisher = roles.find((role) => role.name === 'publisher')?.token;
  const backlog = parts.find((part) => part.backlog)?.backlog;
  if (backlog && publisher === undefined)
    throw new Error(`${declaration.name}: a backlog requires a publisher`);
  return {
    module: ApplicationModule,
    imports: parts.flatMap((part) => part.imports ?? []),
    controllers: [
      HealthController,
      ...parts.flatMap((part) => part.controllers ?? []),
    ],
    exports: [ApplicationReadiness],
    providers: [
      {
        provide: MESSAGE_HANDLERS,
        inject: parts.flatMap((part) => part.handlers ?? []),
        useFactory: (...handlers: unknown[]) => handlers,
      },
      {
        provide: ApplicationReadiness,
        inject: [ServiceHealth],
        useFactory: (health: ServiceHealth): ApplicationReadiness =>
          Object.freeze({ snapshot: () => health.snapshot() }),
      },
      ...parts.flatMap((part) => part.providers ?? []),
      backlog
        ? { provide: BACKLOG, ...backlog }
        : { provide: BACKLOG, useValue: null },
      database
        ? { provide: DATABASE_PROBE, ...database }
        : { provide: DATABASE_PROBE, useValue: null },
      consumer !== undefined
        ? { provide: CONSUMER, useExisting: consumer }
        : { provide: CONSUMER, useValue: null },
      publisher !== undefined
        ? { provide: PUBLISHER, useExisting: publisher }
        : { provide: PUBLISHER, useValue: null },
      {
        provide: ApplicationLifecycle,
        inject: roles.map((role) => role.token),
        useFactory: (...instances: MessagingRole[]) =>
          new ApplicationLifecycle(instances),
      },
      {
        provide: ServiceHealth,
        inject: [
          ApplicationLifecycle,
          DATABASE_PROBE,
          CONSUMER,
          PUBLISHER,
          BACKLOG,
        ],
        useFactory: (
          lifecycle: ApplicationLifecycle,
          probe: DatabaseProbe | null,
          consumer: MessagingRole | null,
          publisher: MessagingRole | null,
          backlog: BacklogSource | null,
        ) =>
          new ServiceHealth(
            declaration,
            {
              ...(backlog ? { backlog } : {}),
              ...(probe ? { database: probe } : {}),
              ...(consumer ? { consumer: () => consumer.snapshot() } : {}),
              ...(publisher ? { publisher: () => publisher.snapshot() } : {}),
            },
            lifecycle,
          ),
      },
    ],
  };
}

import {
  composeApplication,
  preflightApplication,
  readApplicationComposition,
} from '@starter/capabilities/composition';
import {
  HealthController,
  ServiceHealth,
} from '@starter/nest-support/operations';
import { sql } from 'slonik';
import {
  Module,
  Logger,
  Inject,
  type OnApplicationBootstrap,
  type BeforeApplicationShutdown,
  type MiddlewareConsumer,
  type NestModule,
  type ModuleMetadata,
} from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';
import { DatabaseModule } from './database/database.module';
import { UserModule } from './user.module';
import { UserApiModule } from './user-api.module';
import { RequestContextMiddleware } from '@starter/nest-support/context';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { ContextInterceptor } from '@starter/nest-support/context';
import { ExceptionInterceptor } from '@starter/nest-support/http';
import { GraphQLModule } from '@nestjs/graphql';
import { ApolloDriver, type ApolloDriverConfig } from '@nestjs/apollo';
import cors from 'cors';
import type { DatabasePool } from 'slonik';
import { DATABASE_POOL } from './database/database.module';
import { SlonikUserOutbox } from './database/user-outbox';
import { RabbitOutboxPublisher } from './messaging/rabbit-outbox-publisher';
import { userRabbitMqOptions } from './configs/environment';
import { CreateUser } from './application/create-user';
import { RabbitUserCommandConsumer } from './messaging/rabbit-user-command-consumer';

const directory = new URL('./', import.meta.url);
const declaration = preflightApplication(directory);

const interceptors = [
  {
    provide: APP_INTERCEPTOR,
    useClass: ContextInterceptor,
  },
  {
    provide: APP_INTERCEPTOR,
    useClass: ExceptionInterceptor,
  },
];

const parts = composeApplication<ModuleMetadata>(
  declaration,
  readApplicationComposition(directory),
  {
    integrations: {
      persistence: () => ({ imports: [DatabaseModule] }),
      messaging: () => ({}),
      exposure: () => ({
        imports: [
          GraphQLModule.forRoot<ApolloDriverConfig>({
            driver: ApolloDriver,
            autoSchemaFile: true,
          }),
        ],
      }),
    },
    groups: {
      'user-profile': () => ({ imports: [CqrsModule.forRoot(), UserModule] }),
      'user-delivery': () => ({
        providers: [
          {
            provide: RabbitUserCommandConsumer,
            useFactory: (create: CreateUser) =>
              new RabbitUserCommandConsumer(
                userRabbitMqOptions(),
                create,
                new Logger('UserCommands'),
              ),
            inject: [CreateUser],
          },
          {
            provide: RabbitOutboxPublisher,
            useFactory: (pool: DatabasePool) =>
              new RabbitOutboxPublisher(
                userRabbitMqOptions(),
                new SlonikUserOutbox(pool),
                new Logger('UserPublication'),
              ),
            inject: [DATABASE_POOL],
          },
        ],
      }),
      'user-api': () => ({ imports: [UserApiModule] }),
    },
  },
);

@Module({
  imports: parts.flatMap((part) => part.imports ?? []),
  controllers: [
    HealthController,
    ...parts.flatMap((part) => part.controllers ?? []),
  ],
  providers: [
    ...parts.flatMap((part) => part.providers ?? []),
    ...interceptors,
    {
      provide: ServiceHealth,
      useFactory: (
        pool: DatabasePool,
        consumer: RabbitUserCommandConsumer,
        publisher: RabbitOutboxPublisher,
      ) =>
        new ServiceHealth(declaration, {
          database: async () => {
            await pool.query(sql.unsafe`SELECT id FROM users LIMIT 0`);
          },
          consumer: () => consumer.diagnostics.snapshot(),
          publisher: () => publisher.diagnostics.snapshot(),
          backlog: () => new SlonikUserOutbox(pool).backlog(),
        }),
      inject: [DATABASE_POOL, RabbitUserCommandConsumer, RabbitOutboxPublisher],
    },
  ],
})
export class AppModule
  implements NestModule, OnApplicationBootstrap, BeforeApplicationShutdown
{
  constructor(
    @Inject(RabbitOutboxPublisher)
    private readonly publisher: RabbitOutboxPublisher,
    @Inject(RabbitUserCommandConsumer)
    private readonly commands: RabbitUserCommandConsumer,
  ) {}
  onApplicationBootstrap(): void {
    this.publisher.start();
    this.commands.start();
  }
  async beforeApplicationShutdown(): Promise<void> {
    await Promise.all([this.publisher.stop(), this.commands.stop()]);
  }
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes('{*path}');
    // Apollo's Express integration no longer installs GraphQL CORS itself.
    consumer.apply(cors()).forRoutes('graphql');
  }
}

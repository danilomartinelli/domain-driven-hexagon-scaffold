import { composeApplicationModule } from '@starter/nest-support/composition';
import { sql } from 'slonik';
import {
  Module,
  Logger,
  type MiddlewareConsumer,
  type NestModule,
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

const composition = await composeApplicationModule(directory, {
  integrations: {
    persistence: () => ({
      imports: [DatabaseModule],
      database: {
        inject: [DATABASE_POOL],
        useFactory: (pool: DatabasePool) => async () => {
          await pool.query(sql.unsafe`SELECT id FROM users LIMIT 0`);
        },
      },
    }),
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
      publisher: RabbitOutboxPublisher,
      consumer: RabbitUserCommandConsumer,
      backlog: {
        inject: [DATABASE_POOL],
        useFactory: (pool: DatabasePool) => () =>
          new SlonikUserOutbox(pool).backlog(),
      },
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
});

@Module({
  imports: [composition],
  providers: [...interceptors],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes('{*path}');
    // Apollo's Express integration no longer installs GraphQL CORS itself.
    consumer.apply(cors()).forRoutes('graphql');
  }
}

import {
  Module,
  Logger,
  Inject,
  type OnApplicationBootstrap,
  type BeforeApplicationShutdown,
  type MiddlewareConsumer,
  type NestModule,
} from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';
import { DatabaseModule } from './database/database.module';
import { UserModule } from './user.module';
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

@Module({
  imports: [
    DatabaseModule,
    CqrsModule.forRoot(),
    GraphQLModule.forRoot<ApolloDriverConfig>({
      driver: ApolloDriver,
      autoSchemaFile: true,
    }),

    // Modules
    UserModule,
  ],
  controllers: [],
  providers: [
    ...interceptors,
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
})
export class AppModule
  implements NestModule, OnApplicationBootstrap, BeforeApplicationShutdown
{
  constructor(
    @Inject(RabbitOutboxPublisher)
    private readonly publisher: RabbitOutboxPublisher,
  ) {}
  onApplicationBootstrap(): void {
    this.publisher.start();
  }
  async beforeApplicationShutdown(): Promise<void> {
    await this.publisher.stop();
  }
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes('{*path}');
    // Apollo's Express integration no longer installs GraphQL CORS itself.
    consumer.apply(cors()).forRoutes('graphql');
  }
}

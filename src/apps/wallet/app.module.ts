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
  type MiddlewareConsumer,
  type NestModule,
  type ModuleMetadata,
  type OnApplicationBootstrap,
  type BeforeApplicationShutdown,
} from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { GraphQLModule } from '@nestjs/graphql';
import { ApolloDriver, type ApolloDriverConfig } from '@nestjs/apollo';
import {
  ContextInterceptor,
  RequestContextMiddleware,
} from '@starter/nest-support/context';
import { ExceptionInterceptor } from '@starter/nest-support/http';
import cors from 'cors';
import { FindWalletByUser } from './application/find-wallet-by-user';
import { DatabaseModule, DATABASE_POOL } from './database/database.module';
import type { DatabasePool } from 'slonik';
import { CreateWallet } from './application/create-wallet';
import { SlonikWalletCreationTransaction } from './database/wallet-creation.adapter';
import { RabbitWalletConsumer } from './messaging/rabbit-wallet-consumer';
import { walletRabbitMqOptions } from './configs/environment';
import { SlonikWalletReadAdapter } from './database/wallet-read.adapter';
import { FindWalletByUserGraphqlResolver } from './queries/find-wallet-by-user/find-wallet-by-user.graphql-resolver';
import { FindWalletByUserHttpController } from './queries/find-wallet-by-user/find-wallet-by-user.http.controller';

const directory = new URL('./', import.meta.url);
const declaration = preflightApplication(directory);
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
      'wallet-creation': () => ({
        providers: [
          {
            provide: RabbitWalletConsumer,
            useFactory: (pool: DatabasePool) =>
              new RabbitWalletConsumer(
                walletRabbitMqOptions(),
                new CreateWallet(new SlonikWalletCreationTransaction(pool)),
                new Logger('WalletMessaging'),
              ),
            inject: [DATABASE_POOL],
          },
        ],
      }),
      'wallet-lookup': () => ({
        controllers: [FindWalletByUserHttpController],
        providers: [
          FindWalletByUserGraphqlResolver,
          SlonikWalletReadAdapter,
          {
            provide: FindWalletByUser,
            useFactory: (reads: SlonikWalletReadAdapter) =>
              new FindWalletByUser(reads),
            inject: [SlonikWalletReadAdapter],
          },
        ],
      }),
    },
  },
);

/** Wallet's composition root: its database and independently recovering messaging. */
@Module({
  imports: parts.flatMap((part) => part.imports ?? []),
  controllers: [
    HealthController,
    ...parts.flatMap((part) => part.controllers ?? []),
  ],
  providers: [
    ...parts.flatMap((part) => part.providers ?? []),
    { provide: APP_INTERCEPTOR, useClass: ContextInterceptor },
    { provide: APP_INTERCEPTOR, useClass: ExceptionInterceptor },
    {
      provide: ServiceHealth,
      useFactory: (pool: DatabasePool, consumer: RabbitWalletConsumer) =>
        new ServiceHealth(declaration, {
          database: async () => {
            await pool.query(sql.unsafe`SELECT id FROM wallets LIMIT 0`);
          },
          consumer: () => consumer.snapshot(),
        }),
      inject: [DATABASE_POOL, RabbitWalletConsumer],
    },
  ],
})
export class AppModule
  implements NestModule, OnApplicationBootstrap, BeforeApplicationShutdown
{
  constructor(
    @Inject(RabbitWalletConsumer)
    private readonly messaging: RabbitWalletConsumer,
  ) {}

  onApplicationBootstrap(): void {
    this.messaging.start();
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.messaging.stop();
  }

  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes('{*path}');
    // Apollo's Express integration no longer installs GraphQL CORS itself.
    consumer.apply(cors()).forRoutes('graphql');
  }
}

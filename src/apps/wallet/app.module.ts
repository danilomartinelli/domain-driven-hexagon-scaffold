import {
  Module,
  type MiddlewareConsumer,
  type NestModule,
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
import { DatabaseModule } from './database/database.module';
import { SlonikWalletReadAdapter } from './database/wallet-read.adapter';
import { FindWalletByUserGraphqlResolver } from './queries/find-wallet-by-user/find-wallet-by-user.graphql-resolver';
import { FindWalletByUserHttpController } from './queries/find-wallet-by-user/find-wallet-by-user.http.controller';

/** Wallet's composition root: only its own database, no User process or broker. */
@Module({
  imports: [
    DatabaseModule,
    GraphQLModule.forRoot<ApolloDriverConfig>({
      driver: ApolloDriver,
      autoSchemaFile: true,
    }),
  ],
  controllers: [FindWalletByUserHttpController],
  providers: [
    { provide: APP_INTERCEPTOR, useClass: ContextInterceptor },
    { provide: APP_INTERCEPTOR, useClass: ExceptionInterceptor },
    SlonikWalletReadAdapter,
    {
      provide: FindWalletByUser,
      useFactory: (reads: SlonikWalletReadAdapter) =>
        new FindWalletByUser(reads),
      inject: [SlonikWalletReadAdapter],
    },
    FindWalletByUserGraphqlResolver,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes('{*path}');
    // Apollo's Express integration no longer installs GraphQL CORS itself.
    consumer.apply(cors()).forRoutes('graphql');
  }
}

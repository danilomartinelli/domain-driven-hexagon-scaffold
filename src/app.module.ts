import {
  Module,
  type MiddlewareConsumer,
  type NestModule,
} from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';
import { DatabaseModule } from '@libs/db/database.module';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { UserModule } from '@modules/user/user.module';
import { WalletModule } from '@modules/wallet/wallet.module';
import { RequestContextMiddleware } from './libs/application/context/RequestContextMiddleware';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { ContextInterceptor } from './libs/application/context/ContextInterceptor';
import { ExceptionInterceptor } from '@libs/application/interceptors/exception.interceptor';
import { GraphQLModule } from '@nestjs/graphql';
import { ApolloDriver, type ApolloDriverConfig } from '@nestjs/apollo';

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
    EventEmitterModule.forRoot(),
    DatabaseModule,
    CqrsModule.forRoot(),
    GraphQLModule.forRoot<ApolloDriverConfig>({
      driver: ApolloDriver,
      autoSchemaFile: true,
    }),

    // Modules
    UserModule,
    WalletModule,
  ],
  controllers: [],
  providers: [...interceptors],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes('{*path}');
  }
}

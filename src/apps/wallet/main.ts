import 'reflect-metadata';
import { ConsoleLogger, Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { walletHttpPort } from './configs/environment';

async function bootstrap() {
  const port = walletHttpPort();
  const app = await NestFactory.create(AppModule, {
    logger: new ConsoleLogger({ json: true, flattenParams: true }),
  });

  const options = new DocumentBuilder().setTitle('Wallet').build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, options));

  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
  app.enableShutdownHooks();

  await app.listen(port);
  new Logger('Wallet').log(
    `Listening on port ${String(port)}: REST /v1/wallets, GraphQL /graphql`,
  );
}
await bootstrap();

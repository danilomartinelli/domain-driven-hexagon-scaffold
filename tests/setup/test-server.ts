import { afterAll, afterEach, beforeAll } from 'bun:test';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from '@src/app.module';
import { DATABASE_POOL } from '@libs/db/database.module';
import { sql } from 'slonik';
import type { DatabasePool } from 'slonik';
import request from 'supertest';

let app: NestExpressApplication | undefined;
let pool: DatabasePool | undefined;

export function getHttpServer(): request.SuperTest<request.Test> {
  if (!app) throw new Error('Test application has not started.');
  return request(app.getHttpServer());
}

async function cleanDatabase(): Promise<void> {
  await pool?.query(sql.unsafe`TRUNCATE "users", "wallets"`);
}

beforeAll(async () => {
  const testingModule = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  app = testingModule.createNestApplication<NestExpressApplication>();
  pool = app.get<DatabasePool>(DATABASE_POOL);
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));

  try {
    await app.init();
    await cleanDatabase();
  } catch (error) {
    await app.close();
    app = undefined;
    pool = undefined;
    throw error;
  }
});

afterEach(cleanDatabase);

afterAll(async () => {
  // DatabaseModule owns the same pool used by the app and cleanup.
  await app?.close();
  app = undefined;
  pool = undefined;
});

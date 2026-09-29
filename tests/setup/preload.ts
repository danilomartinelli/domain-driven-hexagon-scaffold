import 'reflect-metadata';
import { describe, test } from 'bun:test';
import { setJestCucumberConfiguration } from 'jest-cucumber';

if (process.env.NODE_ENV !== 'test') {
  throw new Error('Run bun test with NODE_ENV=test (Bun sets it by default).');
}

// Load the test environment and check the target before importing the app or
// opening any pool. Shell DB_* overrides are checked too.
const { databaseConfig } = await import('@config/database.config');
if (!/(^|_)tests?($|_)/i.test(databaseConfig.database)) {
  throw new Error(
    `Refusing to run tests against "${databaseConfig.database}". Use a database with a test or tests prefix or suffix, such as ddh_tests.`,
  );
}

setJestCucumberConfiguration({ runner: { describe, test } });

await import('./test-server');

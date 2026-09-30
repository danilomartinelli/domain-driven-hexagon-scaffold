import 'reflect-metadata';
import { describe, test } from 'bun:test';
import { setJestCucumberConfiguration } from 'jest-cucumber';
import { assertTestEnvironment } from '../../database/environment';

// Reject every configured target before importing the app or opening pools.
assertTestEnvironment();
setJestCucumberConfiguration({ runner: { describe, test } });
await import('./test-server');

import { describe, test } from 'bun:test';
import { setJestCucumberConfiguration } from 'jest-cucumber';
import { assertTestEnvironment } from '../../../../../database/environment';

assertTestEnvironment();
setJestCucumberConfiguration({ runner: { describe, test } });
await import('./user-process');

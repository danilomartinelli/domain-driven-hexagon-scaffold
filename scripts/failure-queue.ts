import { existsSync } from 'node:fs';
import { discoverApplications } from '@starter/capabilities/declaration';
import { environmentVariables, readEnvironment } from '../database/environment';
import { operateEnvironment } from './lib/environments';

const apps = new URL('../src/apps/', import.meta.url);

/** A messaging application opts into recovery by owning a failure-queue command. */
function recoverable(app: string | undefined): app is string {
  return discoverApplications(apps).some(
    (declaration) =>
      declaration.name === app &&
      declaration.messaging &&
      existsSync(new URL(`${app}/messaging/failures.ts`, apps)),
  );
}

async function main(): Promise<number> {
  const [app, action, ...args] = process.argv.slice(2);
  if (!recoverable(app) || (action !== 'inspect' && action !== 'replay'))
    throw new Error('Invalid destination or action');
  const options = new Map<string, string>();
  const forward: string[] = [];
  for (const arg of args) {
    if (/^--(environment|run)=/.test(arg)) {
      const index = arg.indexOf('=');
      const name = arg.slice(2, index);
      if (options.has(name)) throw new Error('Duplicate environment option');
      options.set(name, arg.slice(index + 1));
    } else if (/^--(limit|offset|message)=/.test(arg) || arg === '--payload')
      forward.push(arg);
    else throw new Error('Invalid option');
  }
  const environment = options.get('environment');
  const run = options.get('run');
  if ((environment !== 'test' && environment !== 'development') || !run)
    throw new Error('Explicit --environment and --run are required');
  const manifest = readEnvironment(environment, run);
  const expected = environmentVariables(manifest, {});
  // Unlike general development exec, recovery must never follow shell overrides
  // to another broker. The environment runner also verifies Docker ownership.
  for (const name of Object.keys(process.env).filter((key) =>
    key.startsWith('RABBITMQ_'),
  )) {
    if (process.env[name] !== expected[name])
      throw new Error('Conflicting broker setting');
  }
  return operateEnvironment('exec', environment, run, [
    process.execPath,
    '--no-env-file',
    `src/apps/${app}/messaging/failures.ts`,
    action,
    ...forward,
  ]);
}

try {
  process.exitCode = await main();
} catch {
  console.error(
    'Failure-queue command requires an owned, ready environment and matching broker settings. Use --environment=test|development --run=<id>; select inspect or replay on a messaging application with a failure-queue command.',
  );
  process.exitCode = 1;
}

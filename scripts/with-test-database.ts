import { randomUUID } from 'node:crypto';
import { operateEnvironment } from './lib/environments';

// Usage: with-test-database.ts [--app=<name>...] [--] <command>
const command = process.argv.slice(2);
const apps: string[] = [];
while (command[0]?.startsWith('--app='))
  apps.push(command.splice(0, 1)[0].slice(6));
if (command[0] === '--') command.shift();
try {
  process.exitCode = await operateEnvironment(
    'run',
    'test',
    randomUUID().replaceAll('-', '').slice(0, 16),
    command,
    apps.length ? apps : undefined,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}

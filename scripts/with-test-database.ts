import { randomUUID } from 'node:crypto';
import { operateEnvironment } from './lib/environments';

const command = process.argv.slice(2);
if (command[0] === '--') command.shift();
try {
  process.exitCode = await operateEnvironment(
    'run',
    'test',
    randomUUID().replaceAll('-', '').slice(0, 16),
    command,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}

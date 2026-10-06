import { runOperations } from './lib/operations';

try {
  await runOperations(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Operation failed');
  if (!process.exitCode) process.exitCode = 1;
}

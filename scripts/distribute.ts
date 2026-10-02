import { distribute } from './lib/distribution';

try {
  const [app, output, ...extra] = process.argv.slice(2);
  if (!app || (output && !output.startsWith('--output=')) || extra.length)
    throw new Error(
      'Usage: bun scripts/distribute.ts <user|wallet> [--output=<new-directory>]',
    );
  console.log(
    distribute(app, output ? output.slice('--output='.length) : undefined),
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}

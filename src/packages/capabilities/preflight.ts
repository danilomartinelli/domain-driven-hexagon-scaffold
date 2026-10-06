import { preflightApplication } from './composition';

const [directory, ...extra] = process.argv.slice(2);
if (!directory || extra.length)
  throw new Error('Usage: preflight <application directory>');
try {
  console.log(JSON.stringify(preflightApplication(directory)));
} catch (error) {
  console.error(
    error instanceof Error ? error.message : 'Application preflight failed',
  );
  process.exitCode = 1;
}

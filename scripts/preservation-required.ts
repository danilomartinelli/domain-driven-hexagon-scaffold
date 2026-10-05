import { appendFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { changedFiles, isDocumentation } from './lib/changed-files';

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: { base: { type: 'string' }, head: { type: 'string' } },
  });
  const changed = await changedFiles(values);
  // Dispatch and the first push have no previous commit. Validate conservatively.
  const files = changed
    ? changed.filter((file) => !isDocumentation(file))
    : ['(no comparison baseline)'];
  const required = files.length > 0;
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, `required=${String(required)}\n`);
  console.log(
    required
      ? `[preservation:required] ${JSON.stringify(files)}`
      : '[preservation:skipped] Only documentation changed, or no changes.',
  );
}

try {
  await main();
} catch (error) {
  console.error(
    `[preservation:error] ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}

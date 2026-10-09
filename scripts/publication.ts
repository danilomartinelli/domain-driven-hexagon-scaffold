import { approvePlatformImage } from './lib/publication-approve';
import { parseArgs } from 'node:util';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { publicationPlan } from './lib/publication';
import { preparePublication } from './lib/publication-prepare';
import { publishValidated } from './lib/publication-push';
import { ghcrRegistry } from './lib/ghcr';

const cancellation = new AbortController();
const interrupt = () => {
  cancellation.abort('SIGINT');
};
const terminate = () => {
  cancellation.abort('SIGTERM');
};
process.on('SIGINT', interrupt);
process.on('SIGTERM', terminate);

try {
  const { positionals, values } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      repository: { type: 'string' },
      revision: { type: 'string' },
      platform: { type: 'string' },
      output: { type: 'string' },
      image: { type: 'string' },
    },
  });
  const [action, selection] = positionals;
  if (
    !['plan', 'prepare', 'publish', 'approve'].includes(action) ||
    !selection ||
    positionals.length !== 2
  )
    throw new Error(
      'Usage: bun scripts/publication.ts <plan|prepare|publish> <application|all> --repository=<owner/repo> --revision=<commit-sha> [--platform=linux/amd64|linux/arm64 --output=<directory>]',
    );
  if (action === 'approve') {
    const approved = await approvePlatformImage(
      selection,
      values.image ?? '',
      values.platform ?? '',
      cancellation.signal,
    );
    if (!approved) process.exitCode = 1;
  } else {
    const plan = publicationPlan(
      selection,
      values.repository ?? '',
      values.revision ?? '',
    );
    if (action === 'plan') console.log(JSON.stringify(plan));
    else if (action === 'prepare') {
      if (!values.platform || !values.output)
        throw new Error('Preparation requires --platform and --output');
      await preparePublication(
        plan,
        values.platform,
        values.output,
        cancellation.signal,
      );
    } else {
      if (
        !values.output ||
        process.env.GITHUB_EVENT_NAME !== 'workflow_dispatch' ||
        process.env.GITHUB_SHA !== plan.revision ||
        process.env.GITHUB_REPOSITORY?.toLowerCase() !== plan.repository
      )
        throw new Error(
          'Publication requires an explicit workflow_dispatch for this repository and revision',
        );
      const directory = values.output;
      const receipts = ['linux-amd64', 'linux-arm64'].map(
        (platform) =>
          JSON.parse(
            readFileSync(join(directory, platform, 'validated.json'), 'utf8'),
          ) as unknown,
      );
      const result = await publishValidated(
        plan,
        receipts,
        ghcrRegistry(plan, directory, fetch, cancellation.signal),
      );
      writeFileSync(
        join(directory, 'published.json'),
        JSON.stringify(result, null, 2) + '\n',
      );
      if (process.env.GITHUB_STEP_SUMMARY)
        appendFileSync(
          process.env.GITHUB_STEP_SUMMARY,
          `Source: ${plan.revision}\n\n| Application | Immutable image |\n| --- | --- |\n${result.images.map((image) => `| ${image.name} | \`${image.reference}\` |`).join('\n')}\n\nPublication only. No environment was deployed or migrated.\n`,
        );
      console.log(JSON.stringify(result, null, 2));
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  process.off('SIGINT', interrupt);
  process.off('SIGTERM', terminate);
  if (cancellation.signal.aborted)
    process.exitCode = cancellation.signal.reason === 'SIGINT' ? 130 : 143;
}

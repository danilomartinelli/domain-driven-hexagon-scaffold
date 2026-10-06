import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCommand } from './lib/command';

const root = new URL('../', import.meta.url).pathname;
const args = process.argv.slice(2);
if (
  args.length > 1 ||
  (args[0] && !/^--platform=linux\/(amd64|arm64)$/.test(args[0]))
)
  throw new Error(
    'Usage: bun run test:images [--platform=linux/amd64|linux/arm64]',
  );
const platforms = args[0]
  ? [args[0].slice(11)]
  : ['linux/amd64', 'linux/arm64'];
const directory = join(root, '.context/image-checks');
mkdirSync(directory, { recursive: true });
for (const platform of platforms) {
  const suites = [
    { name: 'build', command: ['bun', 'test', './scripts/tests/oci.test.ts'] },
    {
      name: 'user',
      command: ['bun', 'run', 'nx', 'run', 'user:test-distribution'],
    },
    {
      name: 'wallet',
      command: ['bun', 'run', 'nx', 'run', 'wallet:test-distribution'],
    },
    {
      name: 'shutdown',
      command: [
        'bun',
        'scripts/with-test-database.ts',
        '--app=user',
        '--no-database-setup',
        '--',
        'bun',
        'test',
        './scripts/tests/distribution-shutdown.test.ts',
      ],
    },
    {
      name: 'wallet-shutdown',
      command: [
        'bun',
        'scripts/with-test-database.ts',
        '--app=wallet',
        '--no-database-setup',
        '--',
        'bun',
        'test',
        './scripts/tests/distribution-wallet-shutdown.test.ts',
      ],
    },
    {
      name: 'capabilities',
      command: ['bun', 'test', './scripts/tests/image-capabilities.test.ts'],
    },
  ];
  for (const suite of suites) {
    const log = join(
      directory,
      `${platform.replace('/', '-')}-${suite.name}.log`,
    );
    const result = await runCommand(suite.command, {
      cwd: root,
      env: { ...process.env, DDH_IMAGE_PLATFORM: platform },
      timeout: 1_200_000,
      maxOutput: 2_000_000,
      progress: { label: `${platform} ${suite.name}`, logPath: log },
    });
    writeFileSync(log, result.stdout + result.stderr);
    console.log(
      `${platform} ${suite.name}: exit ${String(result.code)}; ${log}`,
    );
    if (result.code !== 0) {
      console.error((result.stdout + result.stderr).slice(-12000));
      process.exit(result.code);
    }
  }
}

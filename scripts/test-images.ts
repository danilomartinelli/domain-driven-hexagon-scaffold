import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCommand } from './lib/command';
import { bunTestCounts } from './lib/test-counts';

const root = new URL('../', import.meta.url).pathname;
const args = process.argv.slice(2);
// CI's light subset keeps image execution, both reproduced publication defects
// and ordinary OCI startup; check:full runs every suite.
const light = args.includes('--light');
const selected = args.filter((arg) => arg !== '--light');
if (
  selected.length > 1 ||
  (selected[0] && !/^--platform=linux\/(amd64|arm64)$/.test(selected[0]))
)
  throw new Error(
    'Usage: bun run test:images[:light] [--platform=linux/amd64|linux/arm64]',
  );
const platforms = selected[0]
  ? [selected[0].slice(11)]
  : ['linux/amd64', 'linux/arm64'];
// Each title fragment selects one of #81's reproduced publication defects.
const reproducedDefects = [
  'custom authenticated state-changing REST routes',
  'unavailable consumer',
];

interface Suite {
  name: string;
  command: string[];
  /** Part of CI's light subset. */
  light?: boolean;
  /** Exact passing tests a filtered run must report. */
  selected?: number;
}
const directory = join(root, '.context/image-checks');
mkdirSync(directory, { recursive: true });
for (const platform of platforms) {
  const suites: Suite[] = [
    {
      name: 'publication',
      command: ['bun', 'test', './scripts/tests/publication-images.test.ts'],
    },
    {
      name: 'publication-readiness',
      light: true,
      command: [
        'bun',
        'test',
        './scripts/tests/publication-readiness.test.ts',
        '--concurrent',
        '--max-concurrency=3',
        ...(light ? ['--test-name-pattern', reproducedDefects.join('|')] : []),
      ],
      // A renamed title must not silently drop a reproduced defect from CI.
      selected: light ? reproducedDefects.length : undefined,
    },
    {
      name: 'build',
      light: true,
      command: ['bun', 'test', './scripts/tests/oci.test.ts'],
    },
    {
      name: 'user',
      light: true,
      command: [
        'bun',
        'test',
        './scripts/tests/publication-startup-preservation.test.ts',
      ],
    },
    {
      name: 'distributions',
      command: ['bun', 'scripts/distribution-images.ts'],
    },
    {
      name: 'capabilities',
      command: [
        'bun',
        'test',
        './scripts/tests/image-capabilities.test.ts',
        '--concurrent',
        '--max-concurrency=3',
      ],
    },
  ];
  for (const suite of suites) {
    if (light && !suite.light) continue;
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
    const passed = bunTestCounts(result.stdout + result.stderr)?.pass;
    if (suite.selected !== undefined && passed !== suite.selected) {
      console.error(
        `${platform} ${suite.name}: expected ${String(suite.selected)} selected tests to pass, observed ${String(passed)}`,
      );
      process.exit(1);
    }
  }
}

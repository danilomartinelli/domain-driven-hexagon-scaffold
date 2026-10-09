import { expect, test } from 'bun:test';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { appWorkspace, generate, run } from './app-generator-fixture';
import { withCleanup } from './cleanup';
import { ghcrRegistry } from '../lib/ghcr';
import { runCommand } from '../lib/command';

const receiptSchema = z.object({
  execution: z.string(),
  artifacts: z.array(
    z.object({ name: z.string(), image: z.string(), id: z.string() }),
  ),
});

test('publication prepares exact executable images for one/all discovery and produces no approval after a runtime failure', async () => {
  const workspace = await appWorkspace();
  await withCleanup(async () => {
    const platform =
      process.env.DDH_IMAGE_PLATFORM ??
      `linux/${process.arch === 'arm64' ? 'arm64' : 'amd64'}`;
    const architectureDirectory = platform.replace('/', '-');
    await run(
      workspace,
      generate(
        'reports',
        '--persistence=false',
        '--messaging=false',
        '--exposure=false',
      ),
    );
    await run(
      workspace,
      generate(
        'ledger',
        '--persistence=true',
        '--messaging=false',
        '--exposure=true',
      ),
    );
    await rm(join(workspace.root, 'src/apps/user'), { recursive: true });
    await rm(join(workspace.root, 'src/apps/wallet'), { recursive: true });
    const prepare = (selection: string, output: string) =>
      workspace.run(
        [
          'bun',
          '--no-env-file',
          'scripts/publication.ts',
          'prepare',
          selection,
          '--repository=acme/scaffold',
          '--revision=0123456789012345678901234567890123456789',
          `--platform=${platform}`,
          `--output=${output}`,
        ],
        { timeout: 600_000 },
      );
    const one = await prepare(
      'reports',
      `.context/one/${architectureDirectory}`,
    );
    expect(one.code, one.stdout + one.stderr).toBe(0);
    expect(one.stdout).toContain(
      'Distribution scenarios reports: no test-distribution target; artifact approval only',
    );
    const receipt = receiptSchema.parse(
      JSON.parse(
        await readFile(
          join(
            workspace.root,
            `.context/one/${architectureDirectory}/validated.json`,
          ),
          'utf8',
        ),
      ),
    );
    expect(
      receipt.artifacts.map((artifact: { name: string }) => artifact.name),
    ).toEqual(['reports']);
    expect(receipt.artifacts[0].id).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(receipt.execution).toMatch(/^(native|emulated)$/);
    const artifact = receipt.artifacts[0];
    await withCleanup(async () => {
      await ghcrRegistry(
        {
          repository: 'acme/scaffold',
          revision: '0123456789012345678901234567890123456789',
          applications: [{ name: 'reports', image: artifact.image }],
        },
        join(workspace.root, '.context/one'),
      ).verifyArchive(artifact, platform);
    }, [
      async () => {
        const removed = await runCommand(
          ['docker', 'image', 'rm', artifact.id],
          { cwd: workspace.root },
        );
        expect(removed.code, removed.stderr).toBe(0);
      },
    ]);
    for (const line of one.stdout.split('\n'))
      if (line.startsWith('Validated ')) console.log(line);
    const main = join(workspace.root, 'src/apps/ledger/main.ts');
    const original = await readFile(main, 'utf8');
    await writeFile(
      main,
      "throw new Error('publication runtime failure');\n" + original,
    );
    const failed = await prepare('all', '.context/failed');
    expect(failed.code).not.toBe(0);
    expect(failed.stderr).toContain('Image validation failed: ledger');
    expect(
      await Bun.file(
        join(workspace.root, '.context/failed/validated.json'),
      ).exists(),
    ).toBe(false);
    await writeFile(main, original);
    const all = await prepare('all', '.context/all');
    expect(all.code, all.stdout + all.stderr).toBe(0);
    for (const line of all.stdout.split('\n'))
      if (line.startsWith('Validated ')) console.log(line);
    const approved = receiptSchema.parse(
      JSON.parse(
        await readFile(
          join(workspace.root, '.context/all/validated.json'),
          'utf8',
        ),
      ),
    );
    expect(
      approved.artifacts.map((artifact: { name: string }) => artifact.name),
    ).toEqual(['ledger', 'reports']);
    expect(
      approved.artifacts.every((artifact: { id: string }) =>
        /^sha256:[a-f0-9]{64}$/.test(artifact.id),
      ),
    ).toBe(true);
  }, [workspace.cleanup]);
}, 1_200_000);

test('publication discovers application scenarios and requires success against the approved image', async () => {
  const workspace = await appWorkspace();
  await withCleanup(async () => {
    await run(
      workspace,
      generate(
        'reports',
        '--persistence=false',
        '--messaging=false',
        '--exposure=false',
      ),
    );
    const platform =
      process.env.DDH_IMAGE_PLATFORM ??
      `linux/${process.arch === 'arm64' ? 'arm64' : 'amd64'}`;
    const projectPath = join(workspace.root, 'src/apps/reports/project.json');
    const project = z
      .object({ targets: z.record(z.string(), z.unknown()) })
      .loose()
      .parse(JSON.parse(await readFile(projectPath, 'utf8')));
    const command =
      'bun scripts/with-test-database.ts --app=reports --no-database-setup -- bun scripts/tests/fixtures/image-capabilities.ts';
    const target = async (failure: boolean) => {
      project.targets['test-distribution'] = {
        executor: 'nx:run-commands',
        cache: false,
        options: {
          command: command + (failure ? ' && bun -e "process.exit(42)"' : ''),
        },
      };
      await writeFile(projectPath, JSON.stringify(project));
    };
    const prepare = (output: string) =>
      workspace.run(
        [
          'bun',
          '--no-env-file',
          'scripts/publication.ts',
          'prepare',
          'reports',
          '--repository=acme/scaffold',
          '--revision=0123456789012345678901234567890123456789',
          `--platform=${platform}`,
          `--output=${output}`,
        ],
        { timeout: 600_000 },
      );
    await target(true);
    const rejected = await prepare('.context/scenario-failed');
    expect(rejected.code, rejected.stdout + rejected.stderr).not.toBe(0);
    expect(rejected.stdout).toContain(
      'Distribution scenarios reports: running test-distribution against sha256:',
    );
    const failedLog = await readFile(
      join(workspace.root, '.context/scenario-failed/reports.log'),
      'utf8',
    );
    expect(failedLog).toContain('Artifact approval reports: approved');
    expect(failedLog).toContain('reports:test-distribution');
    expect(
      await Bun.file(
        join(workspace.root, '.context/scenario-failed/validated.json'),
      ).exists(),
    ).toBe(false);
    await target(false);
    const approved = await prepare('.context/scenario-approved');
    expect(approved.code, approved.stdout + approved.stderr).toBe(0);
    expect(approved.stdout).toContain(
      'Distribution scenarios reports: running test-distribution against sha256:',
    );
    expect(
      await Bun.file(
        join(workspace.root, '.context/scenario-approved/validated.json'),
      ).exists(),
    ).toBe(true);
  }, [workspace.cleanup]);
}, 1_200_000);

test('publication runs User distribution and image shutdown scenarios after approval', async () => {
  const workspace = await appWorkspace();
  await withCleanup(async () => {
    const platform =
      process.env.DDH_IMAGE_PLATFORM ??
      `linux/${process.arch === 'arm64' ? 'arm64' : 'amd64'}`;
    const result = await workspace.run(
      [
        'bun',
        '--no-env-file',
        'scripts/publication.ts',
        'prepare',
        'user',
        '--repository=acme/scaffold',
        '--revision=0123456789012345678901234567890123456789',
        `--platform=${platform}`,
        '--output=.context/user-scenarios',
      ],
      { timeout: 600_000 },
    );
    expect(result.code, result.stdout + result.stderr).toBe(0);
    const log = await readFile(
      join(workspace.root, '.context/user-scenarios/user.log'),
      'utf8',
    );
    expect(
      log.indexOf('Artifact approval user: approved'),
    ).toBeGreaterThanOrEqual(0);
    expect(
      log.indexOf('Distribution scenarios user: running test-distribution'),
    ).toBeGreaterThan(log.indexOf('Artifact approval user: approved'));
    expect(log).toContain('distribution-shutdown.test.ts');
    expect(
      await Bun.file(
        join(workspace.root, '.context/user-scenarios/validated.json'),
      ).exists(),
    ).toBe(true);
  }, [workspace.cleanup]);
}, 900_000);

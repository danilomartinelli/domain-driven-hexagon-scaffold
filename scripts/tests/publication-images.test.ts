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

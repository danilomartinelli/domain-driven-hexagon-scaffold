import { expect, test } from 'bun:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { runCommand } from '../lib/command';
import { withCleanup } from './cleanup';
import { createWorkspace, isolatedEnvironment } from './workspace-fixture';

test('parallel Nx component runs migrate independently under a shared parent', async () => {
  const workspace = await createWorkspace();
  const run = (args: string[], timeout = 180_000) =>
    runCommand(args, {
      cwd: workspace.root,
      timeout,
      maxOutput: 256_000,
      env: {
        ...isolatedEnvironment(),
        NX_TUI: 'false',
        NX_CACHE_DIRECTORY: join(workspace.root, '.nx/cache'),
        NX_WORKSPACE_DATA_DIRECTORY: join(workspace.root, '.nx/workspace-data'),
      },
    });
  await withCleanup(async () => {
    const projectPath = join(workspace.root, 'database/project.json');
    const project = z
      .looseObject({
        targets: z.looseObject({
          'migration-up': z.looseObject({
            options: z.looseObject({ command: z.string() }),
          }),
        }),
      })
      .parse(JSON.parse(await readFile(projectPath, 'utf8')));
    const migration = project.targets['migration-up'].options;
    migration.command = `bun .context/migration-barrier.ts && ${migration.command}`;
    await writeFile(projectPath, JSON.stringify(project));
    await mkdir(join(workspace.root, '.context'), { recursive: true });
    // Hold the first real migration target open until its sibling also enters.
    // Shared Nx invocation roots reject the second task before this barrier.
    await writeFile(
      join(workspace.root, '.context/migration-barrier.ts'),
      `
      import { mkdir, readdir, writeFile } from 'node:fs/promises';
      const directory = '.context/migration-barrier';
      await mkdir(directory, {recursive: true});
      await writeFile(directory + '/' + process.env.DATABASE_APP, 'entered');
      const deadline = Date.now() + 20000;
      while ((await readdir(directory)).length < 2) {
        if (Date.now() > deadline) throw new Error('Sibling migration did not enter');
        await Bun.sleep(25);
      }
    `,
    );
    const result = await run([
      process.execPath,
      'run',
      'nx',
      'affected',
      '--target=test-component',
      '--files=scripts/with-test-database.ts',
      '--parallel=2',
    ]);
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain('user:test-component');
    expect(result.stdout).toContain('wallet:test-component');
  }, [
    async () => {
      const manifests = await Array.fromAsync(
        new Bun.Glob('.context/test-runs/*/environment.json').scan({
          cwd: workspace.root,
        }),
      );
      // Attempt every owned shutdown before deleting the copied workspace. Failed
      // cleanup retains its manifests for a later retry from the reported path.
      await withCleanup(
        () => undefined,
        manifests.map((file) => async () => {
          const manifest = z
            .object({ run: z.string(), status: z.string() })
            .parse(
              JSON.parse(await readFile(join(workspace.root, file), 'utf8')),
            );
          if (manifest.status === 'stopped') return;
          const result = await run(
            [
              process.execPath,
              'scripts/environment-cli.ts',
              'down',
              '--environment=test',
              `--run=${manifest.run}`,
            ],
            60_000,
          );
          if (result.code !== 0)
            throw new Error(
              `Cleanup failed; retained ${workspace.root}: ${result.stderr}`,
            );
        }),
      );
      await workspace.cleanup();
    },
  ]);
}, 240_000);

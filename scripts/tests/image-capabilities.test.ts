import { test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { appWorkspace, generate, run } from './app-generator-fixture';
import { withCleanup } from './cleanup';

test('independent Linux artifacts execute enabled-disabled-enabled from the same prepared application', async () => {
  const workspace = await appWorkspace();
  await withCleanup(async () => {
    const name = 'oci-transition';
    await run(workspace, generate(name, '--persistence=true'));
    const app = join(workspace.root, 'src/apps', name);
    await writeFile(
      join(app, 'database/migrations/1790900000000_transition.sql'),
      '-- Up Migration\nCREATE TABLE retained_artifact_marker (id integer PRIMARY KEY);\n-- Down Migration\nDROP TABLE retained_artifact_marker;\n',
    );
    for (const enabled of [true, false, true]) {
      await writeFile(
        join(app, 'application.json'),
        JSON.stringify({
          name,
          persistence: enabled,
          messaging: enabled,
          exposure: enabled,
        }),
      );
      const output = await run(
        workspace,
        [
          'bun',
          'scripts/with-test-database.ts',
          `--app=${name}`,
          '--no-database-setup',
          '--',
          'bun',
          'scripts/tests/fixtures/image-capabilities.ts',
        ],
        { timeout: 300_000 },
      );
      for (const line of output.split('\n'))
        if (line.startsWith('OCI execution '))
          console.log(`Transition enabled=${String(enabled)} ${line}`);
    }
  }, [workspace.cleanup]);
}, 1_200_000);

for (const persistence of [false, true])
  test(`generated Linux images execute every messaging/exposure combination with persistence=${String(persistence)} using only owned infrastructure`, async () => {
    const workspace = await appWorkspace();
    await withCleanup(async () => {
      for (const messaging of [false, true])
        for (const exposure of [false, true]) {
          const name = `oci-${persistence ? 'p' : 'x'}${messaging ? 'm' : 'x'}${exposure ? 'e' : 'x'}`;
          await run(
            workspace,
            generate(
              name,
              `--persistence=${String(persistence)}`,
              `--messaging=${String(messaging)}`,
              `--exposure=${String(exposure)}`,
            ),
          );
          const output = await run(
            workspace,
            [
              'bun',
              'scripts/with-test-database.ts',
              `--app=${name}`,
              '--no-database-setup',
              '--',
              'bun',
              'scripts/tests/fixtures/image-capabilities.ts',
            ],
            { timeout: 300_000 },
          );
          for (const line of output.split('\n'))
            if (line.startsWith('OCI execution ')) console.log(line);
        }
    }, [workspace.cleanup]);
  }, 1_200_000);

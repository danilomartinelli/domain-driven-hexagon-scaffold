import { test } from 'bun:test';
import { appWorkspace, generate, run } from './app-generator-fixture';
import { withCleanup } from './cleanup';

test('generated Linux images execute every independent capability combination using only owned infrastructure', async () => {
  const workspace = await appWorkspace();
  await withCleanup(async () => {
    for (const persistence of [false, true])
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

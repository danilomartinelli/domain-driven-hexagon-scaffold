import { expect, test } from 'bun:test';
import { rejects } from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommand } from '../lib/command';
import { withCleanup } from './cleanup';
import { removeOwnedContainer } from './owned-container';

const root = new URL('../../', import.meta.url).pathname;

test.each(['inspection', 'removal'])(
  'owned container cleanup preserves %s failures alongside the operation failure',
  async (failure) => {
    const directory = await mkdtemp(join(tmpdir(), 'starter-docker-fault-'));
    await withCleanup(async () => {
      const id = 'a'.repeat(64);
      const docker = `#!/usr/bin/env bun
const args = process.argv.slice(2);
if (args[0] === 'container' && args[1] === 'inspect') {
  if (${JSON.stringify(failure)} === 'inspection') {
    console.error('inspection-failed'); process.exit(17);
  }
  console.log(${JSON.stringify(JSON.stringify([{ Id: id, Config: { Labels: { 'dev.starter.owner': 'fixture-owner' } } }]))});
} else {
  await Bun.write(process.env.CLEANUP_PROBE_LOG, JSON.stringify(args));
  console.error('removal-failed'); process.exit(19);
}
`;
      await writeFile(join(directory, 'docker'), docker, { mode: 0o755 });
      const log = join(directory, 'removal.json');
      const helper = new URL('./owned-container.ts', import.meta.url).pathname;
      const cleanup = new URL('./cleanup.ts', import.meta.url).pathname;
      const result = await runCommand(
        [
          process.execPath,
          '-e',
          `import { removeOwnedContainer } from ${JSON.stringify(helper)};
         import { withCleanup } from ${JSON.stringify(cleanup)};
         await withCleanup(() => { throw new Error('operation-failed'); }, [
           () => removeOwnedContainer({ name: 'fixture', owner: 'fixture-owner' }),
         ]);`,
        ],
        {
          cwd: root,
          env: {
            ...process.env,
            PATH: `${directory}:${process.env.PATH ?? ''}`,
            CLEANUP_PROBE_LOG: log,
          },
        },
      );
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain('operation-failed');
      expect(result.stderr).toContain(`${failure}-failed`);
      if (failure === 'removal') {
        expect(JSON.parse(await readFile(log, 'utf8'))).toEqual([
          'rm',
          '-f',
          id,
        ]);
      } else {
        expect(await Bun.file(log).exists()).toBe(false);
      }
    }, [() => rm(directory, { recursive: true, force: true })]);
  },
);

test('empty expected ownership is rejected before Docker is invoked', async () => {
  await rejects(
    removeOwnedContainer({ name: `absent-${randomUUID()}`, owner: '' }),
    /owner/,
  );
});

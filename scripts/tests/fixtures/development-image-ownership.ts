import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import {
  environmentLocation,
  type EnvironmentManifest,
} from '../../../database/environment';
import { runCommand } from '../../lib/command';
import { operateEnvironment } from '../../lib/environments';
import { withCleanup } from '../cleanup';

const location = environmentLocation('development', 'images');
const manifest: EnvironmentManifest = {
  environment: 'development',
  run: 'images',
  project: location.project,
  owner: randomUUID(),
  status: 'ready',
  databases: [],
  applicationPorts: { user: 3000 },
  topology: [
    {
      name: 'user',
      persistence: false,
      messaging: false,
      exposure: false,
      routes: [],
    },
  ],
};
mkdirSync(location.directory, { recursive: true });
const save = () => {
  writeFileSync(location.manifestPath, JSON.stringify(manifest));
};
save();
writeFileSync(join(location.directory, 'Dockerfile'), 'FROM scratch\n');
const execute = async (args: string[]) => {
  const result = await runCommand(args, {
    cwd: process.cwd(),
    timeout: 30_000,
  });
  assert.equal(result.code, 0, result.stdout + result.stderr);
  return result.stdout.trim();
};
const ownedTag = `${manifest.project}-user:development`;
const aliasTag = `${manifest.project}-alias:preserved`;
const siblingTag = `${manifest.project}-sibling-user:development`;
const build = (tag: string, project: string, owner: string) =>
  execute([
    'docker',
    'build',
    '--tag',
    tag,
    '--label',
    `dev.starter.project=${project}`,
    '--label',
    `dev.starter.owner=${owner}`,
    location.directory,
  ]);
const listed = (tag: string) => execute(['docker', 'image', 'ls', '-q', tag]);
await withCleanup(
  async () => {
    await build(ownedTag, manifest.project, manifest.owner);
    await execute(['docker', 'tag', ownedTag, aliasTag]);
    await build(siblingTag, `${manifest.project}-sibling`, randomUUID());
    assert.equal(await operateEnvironment('down', 'development', 'images'), 0);
    assert.equal(await listed(ownedTag), '');
    assert.notEqual(
      await listed(aliasTag),
      '',
      'An unrelated alias must survive',
    );
    assert.notEqual(
      await listed(siblingTag),
      '',
      'A sibling environment image must survive',
    );
    // Repeated down must tolerate an image whose owned tag was already removed.
    assert.equal(await operateEnvironment('down', 'development', 'images'), 0);

    await build(ownedTag, manifest.project, randomUUID());
    save();
    assert.equal(await operateEnvironment('down', 'development', 'images'), 1);
    assert.notEqual(
      await listed(ownedTag),
      '',
      'A foreign owner must not be removed',
    );
    assert.equal(
      z
        .object({ status: z.string() })
        .parse(JSON.parse(readFileSync(location.manifestPath, 'utf8'))).status,
      'ready',
    );
    assert.equal(
      z
        .object({ cleanupExitCode: z.number() })
        .parse(
          JSON.parse(
            readFileSync(join(location.directory, 'result.json'), 'utf8'),
          ),
        ).cleanupExitCode,
      1,
    );
  },
  [ownedTag, aliasTag, siblingTag].map((tag) => async () => {
    // These exact tags were created by this isolated fixture; never prune the daemon.
    if (await listed(tag)) await execute(['docker', 'image', 'rm', tag]);
  }),
);

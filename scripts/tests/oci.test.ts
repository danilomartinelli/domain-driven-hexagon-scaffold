import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { runCommand } from '../lib/command';
import { withCleanup } from './cleanup';
import { removeOwnedContainer } from './owned-container';

const root = new URL('../../', import.meta.url).pathname;

test('local OCI build packages and executes the selected Linux distribution without a checkout', async () => {
  const tag = `ddh-oci-test:${randomUUID()}`;
  const owner = randomUUID();
  const name = `ddh-oci-probe-${owner}`;
  await withCleanup(async () => {
    const build = await runCommand(
      [
        'bun',
        'run',
        'image:build',
        'user',
        `--tag=${tag}`,
        ...(process.env.DDH_IMAGE_PLATFORM
          ? [`--platform=${process.env.DDH_IMAGE_PLATFORM}`]
          : []),
      ],
      { cwd: root, timeout: 300_000 },
    );
    expect(build.code, build.stdout + build.stderr).toBe(0);
    const probe = await runCommand(
      [
        'docker',
        'run',
        ...(process.env.DDH_IMAGE_PLATFORM
          ? ['--platform', process.env.DDH_IMAGE_PLATFORM]
          : []),
        '--rm',
        '--name',
        name,
        '--label',
        `dev.starter.owner=${owner}`,
        '--network=none',
        tag,
        '-e',
        `import { existsSync } from 'node:fs';
         import metadata from './distribution.json';
         import 'reflect-metadata';
         import './app/app.module.ts';
         console.log(JSON.stringify({platform: process.platform, arch: process.arch,
           packaged: metadata.platform, service: metadata.service,
           source: existsSync('src'), sibling: existsSync('app/wallet'),
           seeds: existsSync('app/database/seeds'), secrets: existsSync('.env')}));`,
      ],
      { cwd: tmpdir(), timeout: 30_000 },
    );
    expect(probe.code, probe.stderr).toBe(0);
    expect(JSON.parse(probe.stdout)).toMatchObject({
      platform: 'linux',
      arch: process.env.DDH_IMAGE_PLATFORM
        ? process.env.DDH_IMAGE_PLATFORM === 'linux/arm64'
          ? 'arm64'
          : 'x64'
        : process.arch,
      packaged: 'linux',
      service: 'user',
      source: false,
      sibling: false,
      seeds: false,
      secrets: false,
    });
  }, [
    () =>
      withCleanup(
        () => removeOwnedContainer({ name, owner }),
        [
          async () => {
            const removed = await runCommand(['docker', 'image', 'rm', tag], {
              cwd: root,
            });
            expect(removed.code, removed.stderr).toBe(0);
          },
        ],
      ),
  ]);
}, 360_000);

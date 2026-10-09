import { runCommand } from '../lib/command';
import { expect, test } from 'bun:test';
import { rejects } from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { appWorkspace, generate, run } from './app-generator-fixture';
import { withCleanup } from './cleanup';
import { createWorkspace } from './workspace-fixture';
import { ghcrRegistry } from '../lib/ghcr';
import {
  publishValidated,
  type PublicationRegistry,
} from '../lib/publication-push';

for (const [runner, phase, signal, code] of [
  ['publication', 'build', 'SIGINT', 130],
  ['publication', 'validation', 'SIGTERM', 143],
  ['distribution', 'build', 'SIGINT', 130],
  ['distribution', 'validation', 'SIGTERM', 143],
  ['distribution', 'scenarios', 'SIGINT', 130],
] as const) {
  test(`${runner} interruption during ${phase} terminates the command, cleans its image and withholds approval`, async () => {
    const workspace = await createWorkspace();
    const bin = join(workspace.root, '.context/bin');
    await mkdir(bin, { recursive: true });
    // These executable doubles exercise the real CLI and process boundary.
    const executable = `#!${process.execPath}
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
process.chdir(${JSON.stringify(workspace.root)});
const args = process.argv.slice(2);
const tagFile = '.context/tag';
const block = () => {
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
    setTimeout(() => {
      writeFileSync('.context/child-cleaned', signal);
      process.exit(0);
    }, 50);
  });
  writeFileSync('.context/ready', String(process.pid));
  setInterval(() => {}, 1000);
};
if (process.argv[1].endsWith('/bun')) {
  if (args.includes('graph')) console.log(JSON.stringify({graph:{nodes:{user:{data:{root:'src/apps/user',targets:{'test-distribution':{}}}}},dependencies:{}}}));
  else if (${JSON.stringify(phase)} === 'scenarios' && args[0] === 'scripts/with-test-database.ts') process.exit(0);
  else block();
}
else if (args[0] === 'info') console.log('arm64');
else if (args[0] === 'buildx') {
  writeFileSync(tagFile, args[args.indexOf('--tag') + 1]);
  if (${JSON.stringify(phase)} === 'build') block();
} else if (args[1] === 'inspect') console.log('sha256:' + '1'.repeat(64));
else if (args[1] === 'ls') {
  if (existsSync(tagFile)) console.log('1'.repeat(64));
} else if (args[1] === 'rm') {
  if (args.at(-1) !== readFileSync(tagFile, 'utf8')) process.exit(2);
  rmSync(tagFile);
  writeFileSync('.context/image-cleaned', 'yes');
} else process.exit(2);
`;
    for (const name of ['docker', 'bun'])
      await writeFile(join(bin, name), executable, { mode: 0o700 });
    const child = Bun.spawn(
      [
        process.execPath,
        '--no-env-file',
        ...(runner === 'distribution'
          ? ['scripts/distribution-images.ts']
          : [
              'scripts/publication.ts',
              'prepare',
              'user',
              '--repository=acme/scaffold',
              `--revision=${'1'.repeat(40)}`,
              '--platform=linux/arm64',
              '--output=.context/prepared',
            ]),
      ],
      {
        cwd: workspace.root,
        env: {
          ...process.env,
          DDH_IMAGE_PLATFORM: 'linux/arm64',
          PATH: `${bin}:${process.env.PATH ?? ''}`,
        },
        stdout: Bun.file(join(workspace.root, '.context/stdout')),
        stderr: Bun.file(join(workspace.root, '.context/stderr')),
      },
    );
    const ready = join(workspace.root, '.context/ready');
    await withCleanup(async () => {
      const deadline = Date.now() + 10_000;
      while (!existsSync(ready) && Date.now() < deadline) await Bun.sleep(20);
      expect(
        existsSync(ready),
        readFileSync(join(workspace.root, '.context/stderr'), 'utf8'),
      ).toBe(true);
      const subprocess = Number(readFileSync(ready, 'utf8'));
      child.kill(signal);
      expect(
        await Promise.race([child.exited, Bun.sleep(5_000).then(() => -1)]),
        readFileSync(join(workspace.root, '.context/stderr'), 'utf8'),
      ).toBe(code);
      expect(existsSync(join(workspace.root, '.context/child-cleaned'))).toBe(
        true,
      );
      expect(() => process.kill(subprocess, 0)).toThrow();
      expect(existsSync(join(workspace.root, '.context/image-cleaned'))).toBe(
        true,
      );
      expect(
        existsSync(join(workspace.root, '.context/prepared/validated.json')),
      ).toBe(false);
    }, [
      async () => {
        await withCleanup(async () => {
          child.kill('SIGKILL');
          await child.exited;
          if (existsSync(ready)) {
            try {
              process.kill(-Number(readFileSync(ready, 'utf8')), 'SIGKILL');
            } catch (error) {
              if (!(
                error instanceof Error &&
                'code' in error &&
                error.code === 'ESRCH'
              ))
                throw error;
            }
          }
        }, [workspace.cleanup]);
      },
    ]);
  }, 20_000);
}

test('GHCR checks architecture commit tags anonymously and fails closed on registry errors', async () => {
  const plan = {
    repository: 'acme/scaffold',
    revision: '1'.repeat(40),
    applications: [{ name: 'reports', image: 'ghcr.io/acme/scaffold/reports' }],
  };
  const requests: { url: string; headers: Headers }[] = [];
  let status = 200;
  const registry = ghcrRegistry(plan, '.context/unused', (url, options) => {
    requests.push({ url, headers: new Headers(options.headers) });
    return Promise.resolve(
      url.includes('/token?')
        ? Response.json({ token: 'anonymous-token' })
        : Response.json(
            { config: { digest: `sha256:${'2'.repeat(64)}` } },
            { status },
          ),
    );
  });
  const reference = `ghcr.io/acme/scaffold/reports:sha-${plan.revision}-amd64`;
  expect((await registry.existing(reference))?.config).toBe(
    `sha256:${'2'.repeat(64)}`,
  );
  expect(requests[0].headers.has('authorization')).toBe(false);
  expect(requests[1].headers.get('authorization')).toBe(
    'Bearer anonymous-token',
  );
  expect(requests[1].url).toBe(
    `https://ghcr.io/v2/acme/scaffold/reports/manifests/sha-${plan.revision}-amd64`,
  );
  status = 404;
  expect(await registry.existing(reference)).toBeUndefined();
  for (const failure of [401, 403, 500]) {
    status = failure;
    await rejects(
      registry.existing(reference),
      /Anonymous GHCR manifest failed/,
    );
  }
});

test('all-app publication preflights every package and preserves failure without completing an index', async () => {
  const plan = {
    repository: 'acme/scaffold',
    revision: '1'.repeat(40),
    applications: [
      { name: 'reports', image: 'ghcr.io/acme/scaffold/reports' },
      { name: 'ledger', image: 'ghcr.io/acme/scaffold/ledger' },
    ],
  };
  const receipts = ['amd64', 'arm64'].map((architecture) => ({
    ...plan,
    platform: `linux/${architecture}`,
    hostArchitecture: architecture,
    execution: 'native',
    artifacts: plan.applications.map((app) => ({
      ...app,
      id: `sha256:${'2'.repeat(64)}`,
    })),
  }));
  const writes: string[] = [];
  const registry: PublicationRegistry = {
    verifyArchive: () => Promise.resolve(),
    requirePublic: (image) =>
      image.endsWith('/ledger')
        ? Promise.reject(new Error('private ledger'))
        : Promise.resolve(),
    existing: () => Promise.resolve(undefined),
    push: (reference) => {
      writes.push(reference);
      return Promise.reject(new Error('registry unavailable'));
    },
    merge: (reference) => {
      writes.push(reference);
      return Promise.resolve(`sha256:${'3'.repeat(64)}`);
    },
  };
  await rejects(publishValidated(plan, receipts, registry), /private ledger/);
  expect(writes).toEqual([]);
  registry.requirePublic = () => Promise.resolve();
  registry.verifyArchive = () => Promise.reject(new Error('corrupt archive'));
  await rejects(publishValidated(plan, receipts, registry), /corrupt archive/);
  expect(writes).toEqual([]);
  registry.verifyArchive = () => Promise.resolve();
  registry.existing = () =>
    Promise.resolve({
      digest: `sha256:${'3'.repeat(64)}`,
      config: `sha256:${'4'.repeat(64)}`,
    });
  await rejects(
    publishValidated(plan, receipts, registry),
    /different artifact/,
  );
  expect(writes).toEqual([]);
  registry.existing = () => Promise.resolve(undefined);
  await rejects(
    publishValidated(plan, receipts, registry),
    /registry unavailable/,
  );
  expect(writes).toEqual([
    `ghcr.io/acme/scaffold/reports:sha-${'1'.repeat(40)}-amd64`,
  ]);
});

test('publication refuses incomplete, mismatched or private artifacts before any registry writes', async () => {
  const plan = {
    repository: 'acme/scaffold',
    revision: '0123456789012345678901234567890123456789',
    applications: [{ name: 'reports', image: 'ghcr.io/acme/scaffold/reports' }],
  };
  const receipts = ['amd64', 'arm64'].map((architecture, index) => ({
    ...plan,
    platform: `linux/${architecture}`,
    hostArchitecture: architecture,
    execution: 'native',
    artifacts: [
      { ...plan.applications[0], id: `sha256:${String(index + 1).repeat(64)}` },
    ],
  }));
  const writes: string[] = [];
  let publicPackage = true;
  const registry: PublicationRegistry = {
    verifyArchive: async () => {},
    requirePublic: () =>
      publicPackage
        ? Promise.resolve()
        : Promise.reject(new Error('Package is private')),
    existing: () => Promise.resolve(undefined),
    push: (image) => {
      writes.push(image);
      return Promise.resolve(`sha256:${'3'.repeat(64)}`);
    },
    merge: (image) => {
      writes.push(image);
      return Promise.resolve(`sha256:${'4'.repeat(64)}`);
    },
  };
  await rejects(
    publishValidated(plan, [receipts[0]], registry),
    /both architectures/,
  );
  await rejects(
    publishValidated(
      plan,
      [receipts[0], { ...receipts[1], revision: '9'.repeat(40) }],
      registry,
    ),
    /source/,
  );
  await rejects(
    publishValidated(plan, [receipts[0], receipts[0]], registry),
    /both architectures/,
  );
  expect(writes).toEqual([]);
  publicPackage = false;
  await rejects(publishValidated(plan, receipts, registry), /private/);
  expect(writes).toEqual([]);
  publicPackage = true;
  const result = await publishValidated(plan, receipts, registry);
  expect(writes).toEqual([
    `ghcr.io/acme/scaffold/reports:sha-${plan.revision}-amd64`,
    `ghcr.io/acme/scaffold/reports:sha-${plan.revision}-arm64`,
    `ghcr.io/acme/scaffold/reports:sha-${plan.revision}`,
  ]);
  expect(result.images[0].reference).toBe(
    `ghcr.io/acme/scaffold/reports@sha256:${'4'.repeat(64)}`,
  );
});

test('publication discovers one or all applications, including a generated application, and rejects unknown selections', async () => {
  const workspace = await appWorkspace();
  await withCleanup(async () => {
    await run(workspace, generate('reports'));
    const plan = (selection: string) =>
      workspace.run([
        'bun',
        '--no-env-file',
        'scripts/publication.ts',
        'plan',
        selection,
        '--repository=acme/scaffold',
        '--revision=0123456789012345678901234567890123456789',
      ]);
    const one = await plan('reports');
    expect(one.code, one.stderr).toBe(0);
    expect(JSON.parse(one.stdout)).toMatchObject({
      applications: [
        {
          name: 'reports',
          image: 'ghcr.io/acme/domain-driven-hexagon-scaffold/reports',
        },
      ],
    });
    const all = await plan('all');
    expect(all.code, all.stderr).toBe(0);
    expect(
      z
        .object({ applications: z.array(z.object({ name: z.string() })) })
        .parse(JSON.parse(all.stdout))
        .applications.map((app) => app.name),
    ).toEqual(['reports', 'user', 'wallet']);
    const unknown = await plan('missing');
    expect(unknown.code).not.toBe(0);
    expect(unknown.stderr).toContain('Unknown application');
    const identityPath = join(workspace.root, 'scaffold.identity.json');
    const identity: unknown = JSON.parse(await readFile(identityPath, 'utf8'));
    const adopted = z
      .object({ packageName: z.string() })
      .loose()
      .parse(identity);
    adopted.packageName = '@acme/adopted';
    await writeFile(identityPath, JSON.stringify(adopted));
    const renamed = await plan('reports');
    expect(renamed.code, renamed.stderr).toBe(0);
    expect(JSON.parse(renamed.stdout)).toMatchObject({
      applications: [
        { name: 'reports', image: 'ghcr.io/acme/acme/adopted/reports' },
      ],
    });
  }, [workspace.cleanup]);
}, 60_000);

test('internal artifact approval refuses an unowned environment before using the platform image', async () => {
  const workspace = await createWorkspace();
  await withCleanup(async () => {
    const result = await runCommand(
      [
        'bun',
        '--no-env-file',
        'scripts/publication.ts',
        'approve',
        'user',
        `--image=sha256:${'a'.repeat(64)}`,
        '--platform=linux/arm64',
      ],
      {
        cwd: workspace.root,
        env: { ...process.env, DDH_ENVIRONMENT_FILE: undefined },
        timeout: 10_000,
      },
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      'Refusing test target without an owned environment',
    );
    expect(result.stdout).not.toContain('"status":"approved"');
  }, [workspace.cleanup]);
});

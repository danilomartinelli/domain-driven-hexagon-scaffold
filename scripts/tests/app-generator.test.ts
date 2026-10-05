import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import {
  cp,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appWorkspace,
  expectRendered,
  generate,
  run,
} from './app-generator-fixture';
import { withApp } from './app-runtime-fixture';
import { withCleanup } from './cleanup';

test('nest-app generates an independent checked project without persistent dry-run output or overwriting collisions', async () => {
  const workspace = await appWorkspace();
  try {
    const apps = await readdir(join(workspace.root, 'src/apps'));
    const lock = await readFile(join(workspace.root, 'bun.lock'), 'utf8');
    const manifest = await readFile(
      join(workspace.root, 'package.json'),
      'utf8',
    );
    await run(workspace, generate('telemetry', '--dry-run'));
    expect(await readdir(join(workspace.root, 'src/apps'))).toEqual(apps);
    expect(await readFile(join(workspace.root, 'bun.lock'), 'utf8')).toBe(lock);
    expect(await readFile(join(workspace.root, 'package.json'), 'utf8')).toBe(
      manifest,
    );
    await run(workspace, generate('telemetry'));
    const project = JSON.parse(
      await run(workspace, [
        'bun',
        'run',
        'nx',
        'show',
        'project',
        'telemetry',
        '--json',
      ]),
    ) as {
      projectType: string;
      tags: string[];
    };
    expect(project.projectType).toBe('application');
    expect(project.tags).toContain('scope:telemetry');
    expect(project.tags).toContain('type:app');
    expect(
      await Bun.file(
        join(workspace.root, 'src/apps/telemetry/package.json'),
      ).json(),
    ).toMatchObject({ private: true, exports: {} });
    await expectRendered(workspace.root, 'telemetry');
    // The defaults keep the previous hybrid capabilities: messaging and exposure.
    expect(
      await Bun.file(
        join(workspace.root, 'src/apps/telemetry/application.json'),
      ).json(),
    ).toEqual({
      name: 'telemetry',
      persistence: false,
      messaging: true,
      exposure: true,
    });
    for (const target of ['test', 'test-component']) {
      const empty = await workspace.run([
        'bun',
        'run',
        'nx',
        'run',
        `telemetry:${target}`,
      ]);
      expect(empty.code).not.toBe(0);
      expect(empty.stdout + empty.stderr).toMatch(
        /No tests found|did not match any test files/,
      );
    }
    for (const invalid of ['--preset=crud', '--persistence=maybe']) {
      const rejected = await workspace.run(generate('rejected', invalid));
      expect(rejected.code, invalid).not.toBe(0);
    }
    expect(existsSync(join(workspace.root, 'src/apps/rejected'))).toBe(false);
    await run(workspace, [
      'bun',
      'run',
      'nx',
      'run-many',
      '--projects=telemetry',
      '--targets=lint,typecheck',
    ]);
    await run(workspace, ['bun', 'run', 'lint:boundaries']);
    const main = join(workspace.root, 'src/apps/telemetry/main.ts');
    const original = await readFile(main, 'utf8');
    const collision = await workspace.run(generate('telemetry'));
    expect(collision.code).not.toBe(0);
    expect(collision.stdout + collision.stderr).toContain('already exists');
    expect(await readFile(main, 'utf8')).toBe(original);
    for (const name of ['../escape', 'user', 'core']) {
      expect((await workspace.run(generate(name))).code).not.toBe(0);
    }
    // Composition consumes the declaration. Withdrawn exposure removes the
    // business adapters while operational HTTP and messaging keep running.
    const declaration = join(
      workspace.root,
      'src/apps/telemetry/application.json',
    );
    const declare = async (capabilities: Record<string, boolean>) => {
      await writeFile(
        declaration,
        JSON.stringify({
          name: 'telemetry',
          persistence: false,
          messaging: true,
          exposure: true,
          ...capabilities,
        }),
      );
    };
    await declare({ exposure: false });
    await withApp(
      {
        cwd: workspace.root,
        command: ['src/apps/telemetry/main.ts'],
        settings: { TELEMETRY_RABBITMQ_URL: 'amqp://127.0.0.1:1' },
      },
      async ({ url }) => {
        expect((await fetch(`${url}/health/ready/http`)).status).toBe(200);
        expect((await fetch(`${url}/health/ready/consumer`)).status).toBe(503);
        const graphql = await fetch(`${url}/graphql`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ query: '{ httpReady }' }),
        });
        expect(graphql.status).toBe(404);
      },
    );
    // Claiming a capability without its adapter fails at startup instead of
    // reporting a dependency the composition lacks.
    await declare({ persistence: true });
    const mismatch = await workspace.run([
      'env',
      'TELEMETRY_HTTP_PORT=1',
      'TELEMETRY_RABBITMQ_URL=amqp://127.0.0.1:1',
      process.execPath,
      '--no-env-file',
      'src/apps/telemetry/main.ts',
    ]);
    expect(mismatch.code).not.toBe(0);
    expect(mismatch.stdout + mismatch.stderr).toContain(
      'supply a database probe exactly when persistence is enabled',
    );
  } finally {
    await workspace.cleanup();
  }
}, 120_000);

test('generated distribution owns its source and needs no database registry or sibling service', async () => {
  const workspace = await appWorkspace();
  const delivery = await mkdtemp(join(tmpdir(), 'generated-delivery-'));
  await withCleanup(async () => {
    await run(workspace, generate('telemetry'));
    await run(workspace, ['bun', 'run', 'nx', 'run', 'telemetry:distribution']);
    const artifact = join(delivery, 'telemetry');
    await cp(join(workspace.root, 'dist/telemetry'), artifact, {
      recursive: true,
      verbatimSymlinks: true,
    });
    const manifest = (await Bun.file(
      join(artifact, 'package.json'),
    ).json()) as { scripts: Record<string, string> };
    expect(manifest.scripts).toEqual({
      start: 'bun --no-env-file app/main.ts',
    });
    expect(
      await Bun.file(join(artifact, 'database/migrate.mjs')).exists(),
    ).toBe(false);
    expect(
      await Bun.file(join(artifact, 'app/tests/unit/README.md')).exists(),
    ).toBe(false);
    expect(
      await Bun.file(join(artifact, 'src/apps/user/main.ts')).exists(),
    ).toBe(false);
    // The original workspace is gone before delivered code executes.
    await workspace.cleanup();
    await withApp(
      {
        cwd: artifact,
        command: ['run', 'start'],
        settings: { TELEMETRY_RABBITMQ_URL: 'amqp://127.0.0.1:1' },
      },
      async ({ url, stop }) => {
        expect((await fetch(`${url}/health/ready/http`)).status).toBe(200);
        expect((await fetch(`${url}/health/ready/consumer`)).status).toBe(503);
        const graphql = await fetch(`${url}/graphql`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ query: '{ httpReady }' }),
        });
        expect(await graphql.json()).toEqual({ data: { httpReady: true } });
        await stop('SIGINT');
      },
    );
  }, [
    () => workspace.cleanup(),
    () => rm(delivery, { recursive: true, force: true }),
  ]);
}, 90_000);

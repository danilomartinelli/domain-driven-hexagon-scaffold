import { expect, test } from 'bun:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  appWorkspace,
  generate,
  run,
  replaceOnce,
} from './app-generator-fixture';
import type { Workspace } from './workspace-fixture';
import { withCleanup } from './cleanup';

const platform =
  process.env.DDH_IMAGE_PLATFORM ??
  `linux/${process.arch === 'arm64' ? 'arm64' : 'amd64'}`;

async function prepare(workspace: Workspace, app: string, output: string) {
  const result = await workspace.run(
    [
      'bun',
      '--no-env-file',
      'scripts/publication.ts',
      'prepare',
      app,
      '--repository=acme/scaffold',
      '--revision=0123456789012345678901234567890123456789',
      `--platform=${platform}`,
      `--output=.context/${output}`,
    ],
    {
      // Build, validation and archive deadlines precede graceful cancellation.
      timeout: 1_140_000,
      cancellation: {
        signal: AbortSignal.timeout(900_000),
        graceMs: 210_000,
      },
    },
  );
  const approved = await Bun.file(
    join(workspace.root, `.context/${output}/validated.json`),
  ).exists();
  return { ...result, approved };
}

test('publication accepts custom authenticated state-changing REST routes without a business request', async () => {
  const workspace = await appWorkspace();
  await withCleanup(async () => {
    await run(
      workspace,
      generate(
        'reports',
        '--persistence=false',
        '--messaging=false',
        '--exposure=true',
      ),
    );
    const directory = join(workspace.root, 'src/apps/reports');
    await writeFile(
      join(directory, 'application.json'),
      JSON.stringify({
        name: 'reports',
        persistence: false,
        messaging: false,
        exposure: true,
        routes: [
          {
            name: 'restricted',
            paths: ['/custom/reports'],
            methods: ['DELETE', 'PUT'],
            stripPath: true,
            upstreamPath: '/restricted',
          },
        ],
      }),
    );
    const main = join(directory, 'main.ts');
    await writeFile(
      main,
      replaceOnce(
        await readFile(main, 'utf8'),
        'await app.listen',
        `
let businessRequests = 0;
app.use((request: { url: string }, response: { status: (code: number) => { json: (value: unknown) => void } }, next: () => void) => {
  if (!request.url.startsWith('/health/')) {
    businessRequests++;
    response.status(401).json({ error: 'Authentication required' });
  } else if (businessRequests) {
    response.status(503).json({ error: 'Generic validator invoked a business operation' });
  } else next();
});
await app.listen`,
      ),
    );
    const result = await prepare(workspace, 'reports', 'custom-route');
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(result.approved).toBe(true);
    const evidence = await readFile(
      join(workspace.root, '.context/custom-route/reports.log'),
      'utf8',
    );
    expect(evidence).toMatch(
      /Kong app-reports target .* address .* UNHEALTHY -> HEALTHY/,
    );
  }, [workspace.cleanup]);
}, 1_170_000);

for (const role of ['consumer', 'publisher']) {
  test(`publication refuses an HTTP-ready artifact with an unavailable ${role} and leaves no receipt`, async () => {
    const workspace = await appWorkspace();
    await withCleanup(async () => {
      await run(
        workspace,
        generate(
          'inbox',
          '--persistence=false',
          '--messaging=true',
          '--exposure=false',
        ),
      );
      const module = join(
        workspace.root,
        'src/apps/inbox/composition/app.module.ts',
      );
      await writeFile(
        module,
        replaceOnce(
          await readFile(module, 'utf8'),
          'messagingOptions(),',
          "{ ...messagingOptions(), broker: 'amqp://127.0.0.1:1' },",
        ),
      );
      if (role === 'publisher')
        await writeFile(
          module,
          replaceOnce(
            await readFile(module, 'utf8'),
            'consumer:',
            'publisher:',
          ),
        );
      const result = await prepare(workspace, 'inbox', `unavailable-${role}`);
      expect(result.code, result.stdout + result.stderr).not.toBe(0);
      expect(result.approved).toBe(false);
      expect(result.stderr).toContain(role);
    }, [workspace.cleanup]);
  }, 1_170_000);
}

for (const exposure of [false, true]) {
  test(`publication respects exposure=${String(exposure)} without inventing an API`, async () => {
    const workspace = await appWorkspace();
    await withCleanup(async () => {
      await run(
        workspace,
        generate(
          'quiet',
          '--persistence=false',
          '--messaging=false',
          '--exposure=true',
        ),
      );
      await writeFile(
        join(workspace.root, 'src/apps/quiet/application.json'),
        JSON.stringify({
          name: 'quiet',
          persistence: false,
          messaging: false,
          exposure,
          routes: exposure
            ? []
            : [{ name: 'retained', paths: ['/retained'], stripPath: false }],
        }),
      );
      const result = await prepare(workspace, 'quiet', 'quiet');
      expect(result.code, result.stdout + result.stderr).toBe(0);
      expect(result.approved).toBe(true);
      const evidence = await readFile(
        join(workspace.root, '.context/quiet/quiet.log'),
        'utf8',
      );
      expect(evidence.includes('UNHEALTHY -> HEALTHY')).toBe(exposure);
      expect(evidence).not.toContain('rabbitmq');
    }, [workspace.cleanup]);
  }, 1_170_000);
}

for (const roles of ['consumer', 'publisher', 'combined'] as const) {
  test(`publication accepts ${roles} messaging after real transient startup`, async () => {
    const workspace = await appWorkspace();
    await withCleanup(async () => {
      await run(
        workspace,
        generate(
          'inbox',
          '--persistence=false',
          '--messaging=true',
          '--exposure=false',
        ),
      );
      const module = join(
        workspace.root,
        'src/apps/inbox/composition/app.module.ts',
      );
      let source = await readFile(module, 'utf8');
      if (roles === 'publisher')
        source = replaceOnce(source, 'consumer:', 'publisher:');
      if (roles === 'combined')
        source = replaceOnce(
          source,
          'consumer:',
          'publisher: () => consumer.snapshot(), consumer:',
        );
      source = replaceOnce(
        source,
        'this.consumer?.start();',
        'setTimeout(() => this.consumer?.start(), 2500);',
      );
      await writeFile(module, source);
      const result = await prepare(workspace, 'inbox', roles);
      expect(result.code, result.stdout + result.stderr).toBe(0);
      expect(result.approved).toBe(true);
      const evidence = await readFile(
        join(workspace.root, `.context/${roles}/inbox.log`),
        'utf8',
      );
      const elapsed = /approved within 60000 ms \(elapsed=(\d+) ms\)/.exec(
        evidence,
      );
      expect(Number(elapsed?.[1])).toBeGreaterThanOrEqual(2500);
      expect(evidence).toContain('approved within 60000 ms');
    }, [workspace.cleanup]);
  }, 1_170_000);
}

async function rejected(
  workspace: Workspace,
  app: string,
  scenario: string,
  condition: string,
): Promise<void> {
  const result = await prepare(workspace, app, scenario);
  expect(result.code, result.stdout + result.stderr).not.toBe(0);
  expect(result.approved).toBe(false);
  const evidence = await readFile(
    join(workspace.root, `.context/${scenario}/${app}.log`),
    'utf8',
  );
  expect(evidence).toContain(condition);
  expect(evidence).toContain('exhausted 60000 ms');
  expect(evidence).toContain('cleanup 0');
}

for (const fault of ['routing', 'listener'] as const) {
  test(`publication refuses Kong ${fault} despite private HTTP readiness`, async () => {
    const workspace = await appWorkspace();
    await withCleanup(async () => {
      await run(
        workspace,
        generate(
          'reports',
          '--persistence=false',
          '--messaging=false',
          '--exposure=true',
        ),
      );
      await writeFile(
        join(workspace.root, 'src/apps/reports/application.json'),
        JSON.stringify({
          name: 'reports',
          persistence: false,
          messaging: false,
          exposure: true,
          routes: [{ name: 'api', paths: ['/reports/api'], stripPath: true }],
        }),
      );
      if (fault === 'listener') {
        const main = join(workspace.root, 'src/apps/reports/main.ts');
        await writeFile(
          main,
          replaceOnce(await readFile(main, 'utf8'), "'0.0.0.0'", "'127.0.0.1'"),
        );
      } else {
        const gateway = join(workspace.root, 'scripts/lib/gateway.ts');
        await writeFile(
          gateway,
          replaceOnce(
            await readFile(gateway, 'utf8'),
            'strip_path: route.stripPath',
            'strip_path: !route.stripPath',
          ),
        );
      }
      await rejected(
        workspace,
        'reports',
        fault,
        fault === 'routing' ? 'strip_path' : 'Kong active target recovery',
      );
    }, [workspace.cleanup]);
  }, 1_170_000);
}

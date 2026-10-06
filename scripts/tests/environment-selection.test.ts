import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { appWorkspace, generate, run } from './app-generator-fixture';
import { withCleanup } from './cleanup';

test('preparing an existing development environment preserves credentials and resource ownership', async () => {
  const workspace = await appWorkspace();
  const prepare = [
    'bun',
    'run',
    'env:prepare',
    '--environment=development',
    '--run=retention',
  ];
  const down = [
    'bun',
    'run',
    'env:down',
    '--environment=development',
    '--run=retention',
  ];
  const inspect = [
    'bun',
    'run',
    'env:exec',
    '--environment=development',
    '--run=retention',
    '--',
    'bun',
    '-e',
    'const m = await Bun.file(process.env.DDH_ENVIRONMENT_FILE).json(); console.log(JSON.stringify({owner:m.owner, databases:m.databases, broker:m.broker}));',
  ];
  await withCleanup(async () => {
    await run(workspace, prepare, { timeout: 120_000 });
    const before = await run(workspace, inspect);
    await run(workspace, prepare, { timeout: 120_000 });
    const after = await run(workspace, inspect);
    expect(after.split('\n').find((line) => line.startsWith('{'))).toBe(
      before.split('\n').find((line) => line.startsWith('{')),
    );
  }, [
    async () => {
      await withCleanup(
        () => run(workspace, down, { timeout: 120_000 }),
        [workspace.cleanup],
      );
      expect(
        await run(workspace, [
          'bun',
          'run',
          'env:inspect',
          '--environment=development',
          '--run=retention',
        ]),
      ).toContain('"status":"stopped"');
    },
  ]);
}, 300_000);

test('an all-disabled generated application prepares without infrastructure or dependency credentials', async () => {
  const workspace = await appWorkspace();
  await withCleanup(async () => {
    await run(
      workspace,
      generate(
        'quiet-worker',
        '--persistence=false',
        '--messaging=false',
        '--exposure=false',
      ),
    );
    await run(
      workspace,
      [
        'bun',
        'run',
        'env:prepare',
        '--environment=test',
        '--run=quiet',
        '--app=quiet-worker',
      ],
      { timeout: 120_000 },
    );
    await run(workspace, [
      'bun',
      'run',
      'env:exec',
      '--environment=test',
      '--run=quiet',
      '--',
      'bun',
      '-e',
      `
      if (!process.env.QUIET_WORKER_HTTP_PORT) throw new Error('Missing operational port');
      for (const key of Object.keys(process.env)) {
        if (key.includes('_DB_') || key.includes('RABBITMQ') || key.startsWith('GATEWAY_')) throw new Error('Disabled credential: ' + key);
      }
      const m = await Bun.file(process.env.DDH_ENVIRONMENT_FILE).json();
      const p = Bun.spawn(['docker', 'ps', '-aq', '--filter', 'label=com.docker.compose.project=' + m.project]);
      if ((await new Response(p.stdout).text()).trim() || await p.exited) throw new Error('Unexpected infrastructure');
    `,
    ]);
    await run(workspace, [
      'env',
      'RABBITMQ_PORT=5672',
      'RABBITMQ_MANAGEMENT_PORT=15999',
      'GATEWAY_HOST=alternate.invalid',
      'GATEWAY_PROXY_PORT=8000',
      'GATEWAY_ADMIN_PORT=8001',
      'bun',
      'scripts/with-test-database.ts',
      '--app=quiet-worker',
      '--',
      'bun',
      '-e',
      `
      const m = await Bun.file(process.env.DDH_ENVIRONMENT_FILE).json();
      if (m.broker || m.gateway || m.databases.length) throw new Error('Unexpected infrastructure from unused overrides');
      if (process.env.RABBITMQ_MANAGEMENT_PORT !== '15999' || process.env.GATEWAY_HOST !== 'alternate.invalid')
        throw new Error('Preparation overrides were discarded');
      for (const key of ['RABBITMQ_USERNAME', 'RABBITMQ_PASSWORD', 'RABBITMQ_MANAGEMENT_URL', 'QUIET_WORKER_RABBITMQ_URL', 'GATEWAY_NAME']) {
        if (process.env[key]) throw new Error('Disabled credential: ' + key);
      }
      `,
    ]);
  }, [
    async () => {
      await withCleanup(
        () =>
          run(
            workspace,
            ['bun', 'run', 'env:down', '--environment=test', '--run=quiet'],
            { timeout: 120_000 },
          ),
        [workspace.cleanup],
      );
    },
  ]);
}, 180_000);

test.each(['gateway', 'gateway-client', 'rabbitmq-client', 'constructor'])(
  'a generated %s application prepares and starts with its owned operational port',
  async (name) => {
    const workspace = await appWorkspace();
    await withCleanup(async () => {
      await run(
        workspace,
        generate(
          name,
          '--persistence=false',
          '--messaging=false',
          '--exposure=false',
        ),
      );
      await run(
        workspace,
        [
          'bun',
          'scripts/with-test-database.ts',
          `--app=${name}`,
          '--',
          'bun',
          'scripts/tests/fixtures/selected-environment.ts',
          name,
          'false',
          'false',
          'false',
          // Nx 23 cannot build a graph for `constructor`; execute its generated
          // entry point through the public environment wrapper instead.
          ...(name === 'constructor' ? ['direct'] : []),
        ],
        { timeout: 120_000 },
      );
    }, [workspace.cleanup]);
  },
  180_000,
);

test('public generator and isolated environments execute every capability union with declared routes and selected startup', async () => {
  const workspace = await appWorkspace();
  await withCleanup(async () => {
    for (let bits = 0; bits < 8; bits++) {
      const name = `selected-${String(bits)}`;
      const persistence = !!(bits & 4);
      const messaging = !!(bits & 2);
      const exposure = !!(bits & 1);
      await run(
        workspace,
        generate(
          name,
          `--persistence=${String(persistence)}`,
          `--messaging=${String(messaging)}`,
          `--exposure=${String(exposure)}`,
        ),
      );
      const app = join(workspace.root, 'src/apps', name);
      await writeFile(
        join(app, 'application.json'),
        JSON.stringify({
          name,
          persistence,
          messaging,
          exposure,
          routes: [
            {
              name: 'graphql',
              paths: [`~/${name}/graphql/?$`],
              stripPath: true,
              upstreamPath: '/graphql',
            },
          ],
        }),
      );
      if (persistence)
        await writeFile(
          join(app, 'database/migrations/1790900000000_selected-marker.sql'),
          `-- Up Migration\nCREATE TABLE selected_marker (id text PRIMARY KEY);\nGRANT SELECT, INSERT ON selected_marker TO ${name.replaceAll('-', '_')}_runtime;\n-- Down Migration\nDROP TABLE selected_marker;\n`,
        );
      await run(
        workspace,
        [
          'bun',
          'scripts/with-test-database.ts',
          `--app=${name}`,
          '--',
          'bun',
          'scripts/tests/fixtures/selected-environment.ts',
          name,
          String(persistence),
          String(messaging),
          String(exposure),
        ],
        { timeout: 180_000 },
      );
    }
    await run(
      workspace,
      [
        'bun',
        'scripts/with-test-database.ts',
        '--app=selected-0',
        '--app=selected-1',
        '--app=selected-2',
        '--app=selected-4',
        '--',
        'bun',
        '-e',
        `
      const {expect} = await import('bun:test');
      const manifest = await Bun.file(process.env.DDH_ENVIRONMENT_FILE).json();
      const child = Bun.spawn(['docker','ps','--filter','label=com.docker.compose.project=' + manifest.project,'--format','{{.Label "com.docker.compose.service"}}']);
      expect((await new Response(child.stdout).text()).trim().split('\\n').sort()).toEqual(['gateway','postgres-selected-4','rabbitmq']);
      expect(await child.exited).toBe(0);
      const {data} = await (await fetch('http://127.0.0.1:' + process.env.GATEWAY_ADMIN_PORT + '/routes')).json();
      expect(data).toHaveLength(1);
      expect(data[0].paths).toEqual(['~/selected-1/graphql/?$']);
      expect(process.env.SELECTED_0_DB_PASSWORD).toBeUndefined();
      expect(process.env.SELECTED_0_RABBITMQ_URL).toBeUndefined();
    `,
      ],
      { timeout: 120000 },
    );
    await writeFile(
      join(workspace.root, 'src/apps/selected-1/application.json'),
      JSON.stringify({
        name: 'selected-1',
        persistence: false,
        messaging: false,
        exposure: true,
      }),
    );
    await run(
      workspace,
      [
        'bun',
        'scripts/with-test-database.ts',
        '--app=selected-1',
        '--',
        'bun',
        '-e',
        `
      const {expect} = await import('bun:test');
      const {data} = await (await fetch('http://127.0.0.1:' + process.env.GATEWAY_ADMIN_PORT + '/routes')).json();
      expect(data).toEqual([]);
    `,
      ],
      { timeout: 120000 },
    );
  }, [workspace.cleanup]);
}, 1_500_000);

test('add disable remove and reactivate retain database credentials and accepted work while producers remain active', async () => {
  const workspace = await appWorkspace();
  const command = (action: string, ...args: string[]) => [
    'bun',
    'run',
    `env:${action}`,
    '--environment=development',
    '--run=retained',
    ...args,
  ];
  const execute = (...args: string[]) =>
    run(workspace, command('exec', '--', ...args), { timeout: 180000 });
  const prepare = (...apps: string[]) =>
    run(workspace, command('prepare', ...apps.map((app) => `--app=${app}`)), {
      timeout: 120000,
    });
  const probe = (phase: string) =>
    execute('bun', 'scripts/tests/fixtures/retained-environment.ts', phase);
  const userPath = join(workspace.root, 'src/apps/user/application.json');
  const walletPath = join(workspace.root, 'src/apps/wallet/application.json');
  const user = await readFile(userPath, 'utf8');
  const wallet = await readFile(walletPath, 'utf8');
  await withCleanup(async () => {
    await prepare('user', 'wallet');
    for (const name of ['user', 'wallet'])
      await execute(
        'env',
        `DATABASE_APP=${name}`,
        'bun',
        'run',
        'migration:up',
      );
    await probe('record');
    await probe('produce');
    await run(
      workspace,
      generate(
        'legacy',
        '--persistence=true',
        '--messaging=false',
        '--exposure=false',
      ),
    );
    await prepare('user', 'wallet', 'legacy');
    // Reconcile an existing cluster whose runtime role is missing; never rotate credentials.
    await execute(
      'bun',
      '-e',
      `
      const {Client} = await import('pg');
      const db = new Client({host:process.env.LEGACY_DB_HOST,port:Number(process.env.LEGACY_DB_PORT),user:process.env.LEGACY_DB_MIGRATION_USERNAME,password:process.env.LEGACY_DB_MIGRATION_PASSWORD,database:process.env.LEGACY_DB_NAME});
      await db.connect(); await db.query('DROP ROLE legacy_runtime'); await db.end();
    `,
    );
    await prepare();
    await execute(
      'bun',
      '-e',
      `
      const {Client} = await import('pg');
      const db = new Client({host:process.env.LEGACY_DB_HOST,port:Number(process.env.LEGACY_DB_PORT),user:process.env.LEGACY_DB_USERNAME,password:process.env.LEGACY_DB_PASSWORD,database:process.env.LEGACY_DB_NAME});
      await db.connect(); await db.query('SELECT 1'); await db.end();
    `,
    );
    await writeFile(
      walletPath,
      JSON.stringify({
        name: 'wallet',
        persistence: false,
        messaging: false,
        exposure: false,
      }),
    );
    await prepare();
    await probe('inactive');
    await probe('produce');
    await rm(walletPath);
    await prepare();
    await probe('inactive');
    await probe('produce');
    const inspection = await run(workspace, command('inspect'));
    expect(inspection).toContain('"app":"wallet"');
    expect(inspection).toContain('"active":false');
    const pathOutput = await execute(
      'bun',
      '-e',
      "console.log('MANIFEST_PATH=' + process.env.DDH_ENVIRONMENT_FILE)",
    );
    const path = /^MANIFEST_PATH=(.+)$/m.exec(pathOutput)?.[1];
    if (!path) throw new Error('Missing environment path');
    const original = await readFile(path, 'utf8');
    const parsed = z
      .record(z.string(), z.unknown())
      .parse(JSON.parse(original));
    await writeFile(path, JSON.stringify({ ...parsed, owner: randomUUID() }));
    try {
      for (const action of ['prepare', 'inspect', 'down']) {
        const refused = await workspace.run(command(action), {
          timeout: 30000,
        });
        expect(refused.code).not.toBe(0);
        expect(refused.stdout + refused.stderr).toContain(
          'Refusing resource owned by another environment',
        );
      }
    } finally {
      await writeFile(path, original);
    }
    await probe('backlog');
    await rm(userPath);
    await prepare();
    const inactive = await run(workspace, command('inspect'));
    expect(inactive).toContain('"active":false');
    await run(workspace, command('down'), { timeout: 120000 });
    await writeFile(userPath, user);
    await writeFile(walletPath, wallet);
    await prepare();
    await probe('backlog');
    await probe('consume');
  }, [
    async () => {
      await withCleanup(
        () => run(workspace, command('down'), { timeout: 120000 }),
        [workspace.cleanup],
      );
      expect(await run(workspace, command('inspect'))).toContain(
        '"status":"stopped"',
      );
    },
  ]);
}, 600_000);

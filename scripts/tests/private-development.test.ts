import { expect, test } from 'bun:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
  appWorkspace,
  generate,
  run,
  replaceOnce,
} from './app-generator-fixture';
import { until, stopStartup } from './app-runtime-fixture';
import { withCleanup } from './cleanup';
import { availablePort } from '../lib/environments';

test('development image cleanup preserves sibling images and aliases and rejects a foreign owner', async () => {
  const workspace = await appWorkspace();
  await withCleanup(
    () =>
      run(workspace, [
        'bun',
        'scripts/tests/fixtures/development-image-ownership.ts',
      ]),
    [workspace.cleanup],
  );
}, 120_000);

test.each(['running', 'stopped', 'missing-source', 'credentials'])(
  'development regression: %s',
  async (scenario) => {
    const workspace = await appWorkspace();
    await withCleanup(
      () =>
        run(workspace, [
          'bun',
          'scripts/tests/fixtures/development-cleanup.ts',
          scenario,
        ]),
      [workspace.cleanup],
    );
  },
  120_000,
);

test('private development watches a real source edit and exposes only an explicitly requested loopback debugger', async () => {
  const workspace = await appWorkspace();
  const execute = [
    'bun',
    'run',
    'env:exec',
    '--environment=development',
    '--run=watch',
    '--',
  ];
  const debugPort = await availablePort();
  const literal = 'dollar-$HOME-${MISSING}-$$';
  await withCleanup(async () => {
    await run(
      workspace,
      generate(
        'watcher',
        '--persistence=false',
        '--messaging=false',
        '--exposure=true',
      ),
    );
    const declaration = join(
      workspace.root,
      'src/apps/watcher/application.json',
    );
    const app = z
      .object({
        name: z.string(),
        persistence: z.boolean(),
        messaging: z.boolean(),
        exposure: z.boolean(),
      })
      .parse(JSON.parse(await readFile(declaration, 'utf8')));
    await writeFile(
      declaration,
      JSON.stringify({
        ...app,
        routes: [
          {
            name: 'graphql',
            paths: ['~/watcher/graphql$'],
            stripPath: true,
            upstreamPath: '/graphql',
          },
        ],
      }),
    );
    await run(
      workspace,
      [
        'bun',
        'run',
        'env:prepare',
        '--environment=development',
        '--run=watch',
        '--app=watcher',
      ],
      { timeout: 120_000 },
    );
    const printed = await run(workspace, [
      ...execute,
      'bun',
      '-e',
      'console.log("PORTS=" + JSON.stringify({http:process.env.WATCHER_HTTP_PORT,gateway:process.env.GATEWAY_PROXY_PORT,project:(await Bun.file(process.env.DDH_ENVIRONMENT_FILE).json()).project}));',
    ]);
    const ports = z
      .object({ http: z.string(), gateway: z.string(), project: z.string() })
      .parse(
        JSON.parse(
          printed
            .split('\n')
            .find((line) => line.startsWith('PORTS='))
            ?.slice(6) ?? 'null',
        ),
      );
    const query = async () => {
      const response = await fetch(
        `http://127.0.0.1:${ports.gateway}/watcher/graphql`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ query: '{ httpReady }' }),
          signal: AbortSignal.timeout(1000),
        },
      ).catch(() => undefined);
      return response?.ok
        ? z
            .object({ data: z.object({ httpReady: z.boolean() }) })
            .parse(await response.json()).data.httpReady
        : undefined;
    };
    for (const mode of ['watch', 'debug']) {
      const child = Bun.spawn(
        [
          ...execute,
          'bun',
          'run',
          'nx',
          'run',
          `watcher:${mode}`,
          '--skip-nx-cache',
        ],
        {
          cwd: workspace.root,
          env: {
            ...process.env,
            DDH_DEBUG_PORT: String(debugPort),
            WATCHER_LITERAL: literal,
          },
          stdout: 'pipe',
          stderr: 'pipe',
          detached: true,
        },
      );
      let output = '';
      const collect = async (stream: ReadableStream<Uint8Array>) => {
        for await (const chunk of stream)
          output += new TextDecoder().decode(chunk);
      };
      const logs = Promise.all([collect(child.stdout), collect(child.stderr)]);
      await withCleanup(async () => {
        await until(
          async () => {
            if (child.exitCode !== null) throw new Error(output);
            return (await query()) === (mode === 'watch');
          },
          120_000,
          'Container application startup',
        );
        expect(
          await fetch(`http://127.0.0.1:${ports.http}/graphql`).then(
            () => true,
            () => false,
          ),
        ).toBe(false);
        if (mode === 'watch') {
          const file = join(
            workspace.root,
            'src/apps/watcher/adapters/status.resolver.ts',
          );
          await writeFile(
            file,
            replaceOnce(
              await readFile(file, 'utf8'),
              "return (await this.health.snapshot()).http.status === 'ready';",
              'return false;',
            ),
          );
          await until(
            async () => (await query()) === false,
            30_000,
            'Source edit observed by container watch',
          );
          expect(
            await fetch(`http://127.0.0.1:${String(debugPort)}`).then(
              () => true,
              () => false,
            ),
          ).toBe(false);
        } else {
          const value = await new Promise<unknown>((resolve, reject) => {
            const socket = new WebSocket(
              `ws://127.0.0.1:${String(debugPort)}/inspect`,
            );
            const timer = setTimeout(() => {
              socket.close();
              reject(new Error('Debugger response timed out'));
            }, 5000);
            socket.onopen = () => {
              socket.send(
                JSON.stringify({
                  id: 1,
                  method: 'Runtime.evaluate',
                  params: {
                    expression:
                      'JSON.stringify([1 + 1, process.env.WATCHER_LITERAL])',
                  },
                }),
              );
            };
            socket.onerror = () => {
              clearTimeout(timer);
              reject(new Error('Debugger connection failed'));
            };
            socket.onmessage = (event) => {
              clearTimeout(timer);
              resolve(JSON.parse(String(event.data)));
              socket.close();
            };
          });
          expect(value).toMatchObject({
            id: 1,
            result: { result: { value: JSON.stringify([2, literal]) } },
          });
          await until(
            () =>
              Promise.resolve(output.includes('Attaching to app-watcher-1')),
            30_000,
            'Supervisor attachment',
          );
          const container = (
            await run(workspace, [
              'docker',
              'ps',
              '-q',
              '--filter',
              `label=com.docker.compose.project=${ports.project}`,
              '--filter',
              'label=com.docker.compose.service=app-watcher',
            ])
          ).trim();
          expect(container).toMatch(/^[a-f0-9]+$/);
          await run(workspace, ['docker', 'kill', container]);
          await until(
            () => Promise.resolve(child.exitCode !== null),
            30_000,
            'Failed application stops its supervisor',
          );
          expect(await child.exited, output).not.toBe(0);
        }
      }, [() => stopStartup(child, logs)]).catch((error: unknown) => {
        throw new Error(`${String(error)}\n${output}`);
      });
    }
    await run(workspace, [
      'bun',
      'run',
      'env:down',
      '--environment=development',
      '--run=watch',
    ]);
    expect(
      (
        await run(workspace, [
          'docker',
          'image',
          'ls',
          '--quiet',
          '--filter',
          `label=dev.starter.project=${ports.project}`,
        ])
      ).trim(),
      'down must remove current and superseded development images',
    ).toBe('');
  }, [
    async () => {
      await withCleanup(
        () =>
          run(
            workspace,
            [
              'bun',
              'run',
              'env:down',
              '--environment=development',
              '--run=watch',
            ],
            { timeout: 120_000 },
          ),
        [workspace.cleanup],
      );
    },
  ]);
}, 360_000);

test('start:debug preserves simultaneous User and Wallet inspectors while business ports remain private', async () => {
  const workspace = await appWorkspace();
  const selection = ['--environment=development', '--run=debug-both'];
  await withCleanup(async () => {
    await run(workspace, ['bun', 'run', 'env:prepare', ...selection], {
      timeout: 120_000,
    });
    const execute = ['bun', 'run', 'env:exec', ...selection, '--'];
    for (const app of ['user', 'wallet'])
      await run(workspace, [
        ...execute,
        'env',
        `DATABASE_APP=${app}`,
        'bun',
        'run',
        'migration:up',
      ]);
    const child = Bun.spawn([...execute, 'bun', 'run', 'start:debug'], {
      cwd: workspace.root,
      env: { ...process.env, DDH_DEBUG_PORT: undefined },
      stdout: 'pipe',
      stderr: 'pipe',
      detached: true,
    });
    let output = '';
    const collect = async (stream: ReadableStream<Uint8Array>) => {
      for await (const chunk of stream)
        output += new TextDecoder().decode(chunk);
    };
    const logs = Promise.all([collect(child.stdout), collect(child.stderr)]);
    await withCleanup(async () => {
      await until(
        () => {
          if (child.exitCode !== null) throw new Error(output);
          return Promise.resolve(
            output.includes('Attaching to app-user-1, app-wallet-1'),
          );
        },
        120_000,
        'Both private debuggers start',
      );
      for (const port of [6499, 6500]) {
        const socket = new WebSocket(`ws://127.0.0.1:${String(port)}/inspect`);
        try {
          await new Promise<void>((resolve, reject) => {
            const deadline = setTimeout(() => {
              reject(new Error('Inspector timeout'));
            }, 5000);
            socket.onopen = () => {
              clearTimeout(deadline);
              resolve();
            };
            socket.onerror = () => {
              clearTimeout(deadline);
              reject(new Error('Inspector unavailable'));
            };
          });
        } finally {
          socket.close();
        }
      }
      const probe = await run(workspace, [
        ...execute,
        'bun',
        '-e',
        `
        for(const app of ['USER','WALLET']) {
          const direct = await fetch('http://127.0.0.1:' + process.env[app+'_HTTP_PORT'] + '/graphql').then(()=>true,()=>false);
          if(direct) throw new Error('Business port published');
          const response = await fetch('http://127.0.0.1:' + process.env.GATEWAY_PROXY_PORT + '/' + app.toLowerCase() + '/graphql', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({query:'{ __typename }'})});
          if(!response.ok) throw new Error('Kong business route unavailable');
        }
        console.log('both-private');
      `,
      ]);
      expect(probe).toContain('both-private');
      await run(workspace, ['bun', 'run', 'env:down', ...selection]);
      await until(
        () => Promise.resolve(child.exitCode !== null),
        30_000,
        'Down stops the active application supervisor',
      );
      await run(workspace, [
        'bun',
        '-e',
        `
        import { readEnvironment } from './database/environment';
        const manifest = readEnvironment('development', 'debug-both', { complete: false });
        for (const args of [
          ['ps', '-aq', '--filter', 'label=com.docker.compose.project=' + manifest.project],
          ['network', 'ls', '-q', '--filter', 'label=com.docker.compose.project=' + manifest.project],
          ['image', 'ls', '-q', '--filter', 'label=dev.starter.project=' + manifest.project],
        ]) {
          const child = Bun.spawn(['docker', ...args]);
          if ((await new Response(child.stdout).text()).trim() || await child.exited)
            throw new Error('Down left application resources behind');
        }
        `,
      ]);
    }, [() => stopStartup(child, logs)]);
  }, [
    async () => {
      await withCleanup(
        () => run(workspace, ['bun', 'run', 'env:down', ...selection]),
        [workspace.cleanup],
      );
    },
  ]);
}, 360_000);

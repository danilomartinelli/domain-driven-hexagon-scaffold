import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  workspaceRoot,
  type EnvironmentManifest,
} from '../../database/environment';
import { approveArtifact } from '../lib/artifact-approval';
import { runCommand, type CommandResult } from '../lib/command';
import { disposableKong } from '../lib/kong-admin';
import { approvalFixture, MemoryKong } from './artifact-approval-fixture';

type Fault = 'inspection-timeout' | 'mutation-response';

/** Exercise the production adapter in a child with an isolated Docker executable. */
export async function runKongApproval(fault: Fault): Promise<CommandResult> {
  const directory = await mkdtemp(join(tmpdir(), 'ddh-kong-approval-'));
  try {
    await writeFile(
      join(directory, 'docker'),
      `#!${process.execPath}
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
const directory = ${JSON.stringify(directory)};
if (process.argv[2] !== 'inspect') process.exit(2);
const counter = directory + '/inspections';
const count = (existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0) + 1;
writeFileSync(counter, String(count));
if (count === 2 && ${JSON.stringify(fault)} === 'inspection-timeout')
  await new Promise(() => setInterval(() => {}, 1000));
console.log(readFileSync(directory + '/inspection.json', 'utf8'));
`,
      { mode: 0o700 },
    );
    const result = await runCommand(
      [
        process.execPath,
        '--no-env-file',
        '-e',
        `import { exerciseKongApproval } from ${JSON.stringify(import.meta.path)};
await exerciseKongApproval(${JSON.stringify(directory)}, ${JSON.stringify(fault)});`,
      ],
      {
        cwd: workspaceRoot,
        env: { ...process.env, PATH: `${directory}:${process.env.PATH ?? ''}` },
        timeout: 10_000,
      },
    );
    return result;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function exerciseKongApproval(
  directory: string,
  fault: Fault,
): Promise<void> {
  const fixture = approvalFixture({ exposure: true });
  const kong = new MemoryKong();
  let mutations = 0;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === '/config') return new Response(null, { status: 204 });
      if (path === '/services')
        return Response.json({ data: await kong.services() });
      if (path === '/routes')
        return Response.json({ data: await kong.routes() });
      if (path === '/upstreams')
        return Response.json({ data: await kong.upstreams() });
      if (path === '/upstreams/app-reports/health')
        return Response.json({ data: await kong.targetHealth() });
      if (
        path === '/upstreams/app-reports/targets/target-id/unhealthy' &&
        request.method === 'PUT'
      ) {
        mutations++;
        await kong.markUnhealthy();
        return new Response(null, {
          status: fault === 'mutation-response' ? 503 : 204,
        });
      }
      return new Response(null, { status: 404 });
    },
  });
  try {
    const adminPort = server.port;
    if (adminPort === undefined)
      throw new Error('Kong fixture has no TCP port');
    const manifest: EnvironmentManifest = {
      ...fixture.environment,
      run: 'approval',
      owner: '00000000-0000-4000-8000-000000000001',
      project: 'approval-fixture',
      status: 'ready',
      databases: [],
      gateway: {
        name: 'approval-gateway',
        host: '127.0.0.1',
        proxyPort: 8000,
        adminPort,
      },
    };
    await writeFile(
      join(directory, 'inspection.json'),
      JSON.stringify([
        {
          Config: {
            Labels: {
              'dev.starter.owner': manifest.owner,
              'com.docker.compose.project': manifest.project,
              'com.docker.compose.service': 'gateway',
            },
          },
          NetworkSettings: {
            Ports: {
              '8001/tcp': [
                { HostIp: '127.0.0.1', HostPort: String(adminPort) },
              ],
            },
          },
        },
      ]),
    );
    // Keep the full logical window while making permanent-failure cases fast.
    fixture.clock.sleep = (milliseconds) => {
      fixture.clock.elapsed += Math.max(1000, milliseconds);
      return Promise.resolve();
    };
    const verdict = await approveArtifact({
      ...fixture,
      kong: disposableKong(manifest),
    });
    console.log(
      JSON.stringify({
        verdict,
        mutations,
        inspections: Number(
          await readFile(join(directory, 'inspections'), 'utf8'),
        ),
        cleaned: fixture.state.cleaned,
      }),
    );
  } finally {
    await server.stop(true);
  }
}

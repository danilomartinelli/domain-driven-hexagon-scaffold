import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workspaceRoot } from '../../database/environment';
import { approveArtifact, monotonicClock } from '../lib/artifact-approval';
import { runCommand, type CommandResult } from '../lib/command';
import { dockerImageRuntime } from '../lib/platform-image-runtime';
import { approvalFixture } from './artifact-approval-fixture';

/** Run the real Docker port adapter with a slow executable isolated to a child. */
export async function runSlowPortApproval(): Promise<CommandResult> {
  const directory = await mkdtemp(join(tmpdir(), 'ddh-image-approval-'));
  try {
    await writeFile(
      join(directory, 'docker'),
      `#!${process.execPath}
if (process.argv[2] !== 'port') process.exit(2);
await Bun.sleep(2200);
`,
      { mode: 0o700 },
    );
    return await runCommand(
      [
        process.execPath,
        '--no-env-file',
        '-e',
        `import { exerciseSlowPortApproval } from ${JSON.stringify(import.meta.path)};
await exerciseSlowPortApproval();`,
      ],
      {
        cwd: workspaceRoot,
        env: { ...process.env, PATH: `${directory}:${process.env.PATH ?? ''}` },
        timeout: 10_000,
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function exerciseSlowPortApproval(): Promise<void> {
  const fixture = approvalFixture();
  const runtime = dockerImageRuntime({
    app: fixture.app,
    image: fixture.image,
    platform: fixture.platform,
    manifest: {
      ...fixture.environment,
      // Only the port command runs; no provisioned test environment is opened.
      environment: 'development',
      run: 'approval',
      owner: '00000000-0000-4000-8000-000000000001',
      project: 'approval-fixture',
      status: 'ready',
      databases: [],
    },
  });
  const verdict = await approveArtifact({
    ...fixture,
    clock: monotonicClock,
    runtime: { ...fixture.runtime, publishedPorts: runtime.publishedPorts },
  });
  console.log(JSON.stringify({ verdict, cleaned: fixture.state.cleaned }));
}

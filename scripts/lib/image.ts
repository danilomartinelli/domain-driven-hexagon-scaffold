import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import {
  selectedApplications,
  validateApplications,
} from '../../database/topology';
import { workspaceRoot } from '../../database/environment';
import { runCommand } from './command';

/** Build in the target Linux environment; only the selected distribution enters the final image. */
export async function buildImage(
  app: string,
  options: {
    platform?: string;
    tag?: string;
    labels?: Record<string, string>;
    execute?: (
      args: string[],
    ) => Promise<{ code: number; stdout: string; stderr: string }>;
  } = {},
): Promise<string> {
  validateApplications(selectedApplications([app]));
  const platform =
    options.platform ?? `linux/${process.arch === 'arm64' ? 'arm64' : 'amd64'}`;
  if (!['linux/amd64', 'linux/arm64'].includes(platform))
    throw new Error('Supported image platforms: linux/amd64, linux/arm64');
  const tag = options.tag ?? `ddh-${app}:local`;
  if (!/^[a-z0-9][a-z0-9._/:-]*$/.test(tag))
    throw new Error('Invalid image tag');
  const context = mkdtempSync(join(tmpdir(), 'ddh-image-'));
  try {
    // An allowlist keeps operator files and host dependencies out of the build context too.
    const files = [
      'package.json',
      'bun.lock',
      '.bun-version',
      'scripts/distribute.ts',
      'scripts/lib/distribution.ts',
      'scripts/lib/distribution-paths.ts',
      'scripts/lib/distribution-selection.ts',
      'database/applications.ts',
      'database/migrate.mjs',
      'database/distribution.ts',
      'tooling/config',
      'tooling/generators/package.json',
      `src/apps/${app}`,
      'src/packages',
      'docker/application.Dockerfile',
    ];
    for (const file of files) {
      mkdirSync(dirname(join(context, file)), { recursive: true });
      cpSync(join(workspaceRoot, file), join(context, file), {
        recursive: true,
        filter: (path) =>
          !['node_modules', 'tests', '.secrets', 'secrets'].includes(
            basename(path),
          ) && !basename(path).startsWith('.env'),
      });
    }
    // The artifact fallback documentation is optional in disposable workspaces.
    mkdirSync(join(context, 'docs'), { recursive: true });
    if (existsSync(join(workspaceRoot, 'docs/distribution.md')))
      cpSync(
        join(workspaceRoot, 'docs/distribution.md'),
        join(context, 'docs/distribution.md'),
      );
    const execute =
      options.execute ??
      ((args: string[]) =>
        runCommand(args, {
          cwd: context,
          timeout: 300_000,
          maxOutput: 1_000_000,
        }));
    const result = await execute([
      'docker',
      'buildx',
      'build',
      '--progress=plain',
      '--load',
      '--platform',
      platform,
      '--tag',
      tag,
      ...Object.entries(options.labels ?? {}).flatMap(([key, value]) => [
        '--label',
        `${key}=${value}`,
      ]),
      '--file',
      join(context, 'docker/application.Dockerfile'),
      '--build-arg',
      `BUN_VERSION=${readFileSync(join(workspaceRoot, '.bun-version'), 'utf8').trim()}`,
      '--build-arg',
      `APPLICATION=${app}`,
      context,
    ]);
    if (result.code !== 0)
      throw new Error(
        `Image build failed (${String(result.code)}):\n${result.stdout}${result.stderr}`,
      );
    return tag;
  } finally {
    rmSync(context, { recursive: true, force: true });
  }
}

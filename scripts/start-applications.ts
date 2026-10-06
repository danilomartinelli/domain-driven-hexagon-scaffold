import { readEnvironmentFile } from '../database/environment';
import { selectedApplications } from '../database/topology';
import { runApplicationContainers } from './lib/application-containers';

const target = process.argv[2];
if (!['serve', 'watch', 'debug'].includes(target))
  throw new Error('Select serve, watch or debug');
const apps = process.env.DDH_ENVIRONMENT_FILE
  ? (readEnvironmentFile(process.env.DDH_ENVIRONMENT_FILE).topology ?? [])
  : selectedApplications();
if (apps.length) {
  const manifest = process.env.DDH_ENVIRONMENT_FILE
    ? readEnvironmentFile(process.env.DDH_ENVIRONMENT_FILE)
    : undefined;
  if (manifest?.environment === 'development') {
    process.exitCode = await runApplicationContainers(
      manifest,
      apps.map((app) => app.name),
      target,
    );
  } else {
    const child = Bun.spawn(
      [
        process.execPath,
        '--no-env-file',
        'run',
        'nx',
        'run-many',
        `--projects=${apps.map((app) => app.name).join(',')}`,
        `--target=${target}`,
        `--parallel=${String(apps.length)}`,
        '--output-style=stream',
      ],
      { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' },
    );
    process.exitCode = await child.exited;
  }
}

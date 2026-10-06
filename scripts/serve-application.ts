import { readEnvironmentFile } from '../database/environment';
import { selectedApplications } from '../database/topology';
import {
  applicationDebugPort,
  runApplicationContainers,
} from './lib/application-containers';

const [name, mode] = process.argv.slice(2);
selectedApplications([name]);
if (!['serve', 'watch', 'debug'].includes(mode))
  throw new Error('Select serve, watch or debug');
const manifest = process.env.DDH_ENVIRONMENT_FILE
  ? readEnvironmentFile(process.env.DDH_ENVIRONMENT_FILE)
  : undefined;
if (manifest?.environment === 'development') {
  process.exitCode = await runApplicationContainers(manifest, [name], mode);
} else {
  const child = Bun.spawn(
    [
      process.execPath,
      '--no-env-file',
      ...(mode === 'debug'
        ? [`--inspect=127.0.0.1:${String(applicationDebugPort(name))}`]
        : []),
      ...(mode === 'watch' || mode === 'debug' ? ['--watch'] : []),
      `src/apps/${name}/main.ts`,
    ],
    { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' },
  );
  const stop = () => {
    child.kill('SIGTERM');
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  try {
    process.exitCode = await child.exited;
  } finally {
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
  }
}

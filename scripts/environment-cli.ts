import { z } from 'zod';
import { operateEnvironment } from './lib/environments';

async function main() {
  const inNx = process.argv[2] === '--nx';
  const invocation =
    inNx && process.env.DDH_ENVIRONMENT_ARGS
      ? z.array(z.string()).parse(JSON.parse(process.env.DDH_ENVIRONMENT_ARGS))
      : process.argv.slice(inNx ? 3 : 2);
  const [action, ...args] = invocation;
  if (
    action !== 'prepare' &&
    action !== 'down' &&
    action !== 'exec' &&
    action !== 'inspect' &&
    action !== 'dev'
  )
    throw new Error(
      'Usage: environment-cli.ts prepare|down|exec|inspect --environment=test|development --run=<id> [-- command]\n' +
        '       environment-cli.ts dev --run=<id>\n' +
        'Repeat --app=<name> with prepare or dev to select applications.',
    );
  if (!inNx) {
    const child = Bun.spawn(
      [
        process.execPath,
        '--no-env-file',
        'run',
        'nx',
        'run',
        `infrastructure:${action}`,
      ],
      {
        env: {
          ...process.env,
          DDH_ENVIRONMENT_ARGS: JSON.stringify(invocation),
          // Independent environment invocations can share a parent test target.
          // Nx 23 keys loop detection by root PID + task ID, including siblings.
          NX_INVOCATION_ROOT_PID: String(process.pid),
        },
        stdin: 'inherit',
        stdout: 'inherit',
        stderr: 'inherit',
      },
    );
    return child.exited;
  }
  delete process.env.DDH_ENVIRONMENT_ARGS;
  const separator = args.indexOf('--');
  const options = separator === -1 ? args : args.slice(0, separator);
  const command = separator === -1 ? [] : args.slice(separator + 1);
  for (const option of options)
    if (!/^--(environment|run|app)=/.test(option))
      throw new Error(`Unknown option: ${option}`);
  const environment =
    options.find((option) => option.startsWith('--environment='))?.slice(14) ??
    (action === 'dev' ? 'development' : 'test');
  if (environment !== 'test' && environment !== 'development')
    throw new Error('Environment must be test or development.');
  const run =
    options.find((option) => option.startsWith('--run='))?.slice(6) ??
    'default';
  const apps = options
    .filter((option) => option.startsWith('--app='))
    .map((option) => option.slice(6));
  return operateEnvironment(
    action,
    environment,
    run,
    command,
    apps.length ? apps : undefined,
  );
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}

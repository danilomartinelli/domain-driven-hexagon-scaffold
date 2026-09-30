import { z } from 'zod';
import { operateEnvironment } from './lib/environments';

async function main() {
  const inNx = process.argv[2] === '--nx';
  const invocation =
    inNx && process.env.DDH_ENVIRONMENT_ARGS
      ? z.array(z.string()).parse(JSON.parse(process.env.DDH_ENVIRONMENT_ARGS))
      : process.argv.slice(inNx ? 3 : 2);
  const [action, ...args] = invocation;
  if (action !== 'prepare' && action !== 'down' && action !== 'exec')
    throw new Error(
      'Usage: environment-cli.ts prepare|down|exec --environment=test|development --run=<id> [-- command]',
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
    if (!/^--(environment|run)=/.test(option))
      throw new Error(`Unknown option: ${option}`);
  const environment =
    options.find((option) => option.startsWith('--environment='))?.slice(14) ??
    'test';
  if (environment !== 'test' && environment !== 'development')
    throw new Error('Environment must be test or development.');
  const run =
    options.find((option) => option.startsWith('--run='))?.slice(6) ??
    'default';
  return operateEnvironment(action, environment, run, command);
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}

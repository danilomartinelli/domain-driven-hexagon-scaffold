import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  appendFileSync,
  mkdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { constants } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = realpathSync(fileURLToPath(new URL('../', import.meta.url)));

async function main(): Promise<number> {
  const command = process.argv.slice(2);
  if (command[0] === '--') command.shift();
  if (command.length === 0) {
    console.error(
      'Usage: bun scripts/with-test-database.ts -- <command> [args...]',
    );
    return 2;
  }

  const workspace = createHash('sha256').update(root).digest('hex').slice(0, 8);
  const runId = randomUUID().replaceAll('-', '').slice(0, 16);
  const project = `ddh-test-${workspace}-${runId}`;
  const database = project.replaceAll('-', '_');
  const directory = join(root, '.context/test-runs', project);
  mkdirSync(directory, { recursive: true });
  const logPath = join(directory, 'run.log');
  const env = { ...process.env, NODE_ENV: 'test', DDH_TEST_DATABASE: database };
  const compose = [
    'docker',
    'compose',
    '--project-name',
    project,
    '--file',
    join(root, 'docker/docker-compose.test.yml'),
  ];
  let active: ChildProcess | undefined;
  let interrupted = 0;
  let cleaning = false;
  let commandExitCode: number | undefined;
  let exitCode = 1;
  let port: string | undefined;

  function log(message: string): void {
    console.log(message);
    appendFileSync(logPath, `${message}\n`);
  }

  function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if (!(
        error instanceof Error &&
        'code' in error &&
        error.code === 'ESRCH'
      ))
        throw error;
    }
  }

  const interrupt = (signal: NodeJS.Signals): void => {
    if (interrupted) return;
    interrupted = signal === 'SIGINT' ? 130 : 143;
    if (active && !cleaning) killGroup(active, 'SIGTERM');
  };
  const onInterrupt = (): void => {
    interrupt('SIGINT');
  };
  const onTerminate = (): void => {
    interrupt('SIGTERM');
  };
  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onTerminate);

  async function execute(
    args: string[],
    options: {
      env?: NodeJS.ProcessEnv;
      timeout?: number;
      capture?: boolean;
    } = {},
  ): Promise<{ code: number; stdout: string }> {
    if (interrupted && !cleaning) return { code: interrupted, stdout: '' };
    log(`$ ${args.join(' ')}`);
    const child = spawn(args[0], args.slice(1), {
      cwd: root,
      env: options.env ?? env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    active = child;
    let stdout = '';
    let timedOut = false;
    let forceKill: ReturnType<typeof setTimeout> | undefined;
    const timeout = setTimeout(() => {
      timedOut = true;
      killGroup(child, 'SIGTERM');
      forceKill = setTimeout(() => {
        killGroup(child, 'SIGKILL');
      }, 5_000);
    }, options.timeout ?? 60_000);
    const cancelKill = (): void => {
      if (!cleaning)
        forceKill ??= setTimeout(() => {
          killGroup(child, 'SIGKILL');
        }, 5_000);
    };
    process.once('SIGINT', cancelKill);
    process.once('SIGTERM', cancelKill);
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      process.stdout.write(chunk);
      appendFileSync(logPath, chunk);
      if (options.capture) stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      process.stderr.write(chunk);
      appendFileSync(logPath, chunk);
    });
    try {
      const code = await new Promise<number>((resolve) => {
        child.once('error', (error) => {
          log(error.message);
          resolve(1);
        });
        child.once('close', (status, signal) => {
          resolve(
            timedOut
              ? 124
              : (status ?? (signal ? 128 + constants.signals[signal] : 1)),
          );
        });
      });
      return { code, stdout };
    } finally {
      clearTimeout(timeout);
      clearTimeout(forceKill);
      process.removeListener('SIGINT', cancelKill);
      process.removeListener('SIGTERM', cancelKill);
      active = undefined;
    }
  }

  async function runWorkflow(): Promise<number> {
    const up = await execute([
      ...compose,
      'up',
      '--detach',
      '--wait',
      '--wait-timeout',
      '45',
    ]);
    if (up.code !== 0) return up.code;
    const binding = await execute([...compose, 'port', 'postgres', '5432'], {
      capture: true,
    });
    if (binding.code !== 0) return binding.code;
    port = /^127\.0\.0\.1:(\d+)\s*$/.exec(binding.stdout)?.[1];
    if (!port)
      throw new Error('Expected an isolated loopback PostgreSQL port.');
    // Never forward the caller's development target to migrations or destructive tests.
    const testEnv = {
      ...env,
      DB_HOST: '127.0.0.1',
      DB_PORT: port,
      DB_USERNAME: 'user',
      DB_PASSWORD: 'password',
      DB_NAME: database,
    };
    const migration = await execute(
      [process.execPath, 'run', 'migration:up:tests'],
      { env: testEnv },
    );
    if (migration.code !== 0) return migration.code;
    const result = await execute(command, { env: testEnv, timeout: 300_000 });
    commandExitCode = result.code;
    return result.code;
  }

  log(`Test run: ${project}`);
  log(`Logs: ${logPath}`);
  try {
    exitCode = await runWorkflow();
  } catch (error) {
    log(error instanceof Error ? error.message : String(error));
    exitCode = 1;
  } finally {
    cleaning = true;
    await execute([...compose, 'logs', '--no-color'], { timeout: 15_000 });
    const cleanup = await execute(
      [...compose, 'down', '--remove-orphans', '--timeout', '10'],
      { timeout: 30_000 },
    );
    const cleanupExitCode = cleanup.code;
    if (interrupted) exitCode = interrupted;
    else if (exitCode === 0 && cleanupExitCode !== 0)
      exitCode = cleanupExitCode;
    writeFileSync(
      join(directory, 'result.json'),
      JSON.stringify(
        { project, database, port, commandExitCode, cleanupExitCode, exitCode },
        null,
        2,
      ) + '\n',
    );
    log(
      `Test run finished with status ${String(exitCode)}; cleanup status ${String(cleanupExitCode)}.`,
    );
    process.removeListener('SIGINT', onInterrupt);
    process.removeListener('SIGTERM', onTerminate);
  }
  return exitCode;
}

process.exitCode = await main();

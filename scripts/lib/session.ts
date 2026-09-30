import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { constants } from 'node:os';

interface Session {
  execute(
    args: string[],
    options?: {
      env?: NodeJS.ProcessEnv;
      /** null disables the deadline for long-lived development commands. */
      timeout?: number | null;
      capture?: boolean;
      /** false keeps output in the run log only. */
      echo?: boolean;
    },
  ): Promise<{ code: number; stdout: string }>;
  log(message: string): void;
  readonly interrupted: number;
  startCleanup(): void;
  close(): void;
}

export function commandSession(
  root: string,
  logPath: string,
  env: NodeJS.ProcessEnv,
): Session {
  let active: ChildProcess | undefined;
  let interrupted = 0;
  let cleaning = false;

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
      timeout?: number | null;
      capture?: boolean;
      echo?: boolean;
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
    const timeout =
      options.timeout === null
        ? undefined
        : setTimeout(() => {
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
      if (options.echo !== false) process.stdout.write(chunk);
      appendFileSync(logPath, chunk);
      if (options.capture) stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      if (options.echo !== false) process.stderr.write(chunk);
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

  return {
    execute,
    log,
    get interrupted() {
      return interrupted;
    },
    startCleanup() {
      cleaning = true;
    },
    close() {
      process.removeListener('SIGINT', onInterrupt);
      process.removeListener('SIGTERM', onTerminate);
    },
  };
}

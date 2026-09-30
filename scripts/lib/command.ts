import { spawn } from 'node:child_process';

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Run a bounded process group, including shell wrappers and their descendants. */
export async function runCommand(
  args: string[],
  options: { cwd: string; timeout?: number; env?: NodeJS.ProcessEnv },
): Promise<CommandResult> {
  const child = spawn(args[0], args.slice(1), {
    cwd: options.cwd,
    env: options.env ?? process.env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  const termination = { timedOut: false, outputOverflow: false };
  const terminate = (): void => {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch (error) {
      if (!(
        error instanceof Error &&
        'code' in error &&
        error.code === 'ESRCH'
      ))
        throw error;
    }
  };
  const deadline = setTimeout(() => {
    termination.timedOut = true;
    terminate();
  }, options.timeout ?? 30_000);
  const capture = (current: string, data: string): string => {
    if (current.length + data.length > 64_000) {
      termination.outputOverflow = true;
      terminate();
    }
    return (current + data).slice(-64_000);
  };
  child.stdout.setEncoding('utf8').on('data', (data: string) => {
    stdout = capture(stdout, data);
  });
  child.stderr.setEncoding('utf8').on('data', (data: string) => {
    stderr = capture(stderr, data);
  });
  try {
    const code = await new Promise<number>((resolve) => {
      child.once('error', (error) => {
        stderr += error.message;
        resolve(2);
      });
      child.once('close', (status) => {
        resolve(status ?? 2);
      });
    });
    if (termination.outputOverflow)
      stderr +=
        '\nCommand output exceeded 64,000 characters; result is incomplete.';
    return {
      code: termination.timedOut
        ? 124
        : termination.outputOverflow
          ? 125
          : code,
      stdout,
      stderr,
      timedOut: termination.timedOut,
    };
  } finally {
    clearTimeout(deadline);
  }
}

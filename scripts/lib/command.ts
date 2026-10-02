import { spawn } from 'node:child_process';

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Run a process group with a deadline and a configurable output limit. */
export async function runCommand(
  args: string[],
  options: {
    cwd: string;
    timeout?: number;
    env?: NodeJS.ProcessEnv;
    /** Characters per stream; Infinity retains complete Git file inventories. */
    maxOutput?: number;
    /** Keep the first output for previews; diagnostics default to the tail. */
    outputRetention?: 'head' | 'tail';
    /** Identify long nested runs without echoing arguments or environment values. */
    progress?: { label: string; logPath: string; intervalMs?: number };
  },
): Promise<CommandResult> {
  const maxOutput = options.maxOutput ?? 64_000;
  const child = spawn(args[0], args.slice(1), {
    cwd: options.cwd,
    env: options.env ?? process.env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  const startedAt = Date.now();
  let lastOutputAt = startedAt;
  const label = options.progress?.label ?? args[0];
  const logHint = options.progress ? ` Log: ${options.progress.logPath}.` : '';
  const progress = options.progress;
  if (progress)
    process.stderr.write(
      `[command:started] ${label}; deadline ${String(options.timeout ?? 30_000)} ms.${logHint}\n`,
    );
  const heartbeat = progress
    ? setInterval(() => {
        process.stderr.write(
          `[command:running] ${label}; elapsed ${String(Date.now() - startedAt)} ms; last output ${String(Date.now() - lastOutputAt)} ms ago.${logHint}\n`,
        );
      }, progress.intervalMs ?? 30_000)
    : undefined;
  const termination = { timedOut: false, outputOverflow: false };
  const terminate = (): void => {
    if (child.pid === undefined) return;
    try {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch (error) {
        if (!(
          process.platform === 'darwin' &&
          error instanceof Error &&
          'code' in error &&
          error.code === 'EPERM'
        ))
          throw error;
        // Darwin can reject a group containing only an unreaped zombie.
        // A direct signal accepts that state but still rejects denied access.
        process.kill(child.pid, 'SIGKILL');
      }
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
    lastOutputAt = Date.now();
    if (current.length + data.length > maxOutput) {
      termination.outputOverflow = true;
      terminate();
    }
    return options.outputRetention === 'head'
      ? (current + data).slice(0, maxOutput)
      : (current + data).slice(-maxOutput);
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
      stderr += `\nCommand output exceeded ${maxOutput.toLocaleString('en-US')} characters; result is incomplete.`;
    if (termination.timedOut)
      stderr += `\nCommand ${label} timed out after ${String(options.timeout ?? 30_000)} ms.${logHint}`;
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
    clearInterval(heartbeat);
  }
}

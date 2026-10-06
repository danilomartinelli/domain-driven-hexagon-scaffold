import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { CommandResult } from './command';
import { writeJson } from './operations-config';

/** Retain subprocess evidence before disposable containers disappear, without command arguments or credentials. */
export function operationsDiagnostics(
  directory: string,
  operation: string,
): {
  logPath: string;
  record: (result: CommandResult, cleanup: boolean) => void;
  finish: (code: number) => void;
} {
  const path = join(directory, 'logs', randomUUID());
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const logPath = join(path, 'run.log');
  const secretDirectory = join(directory, 'secrets');
  const secrets = existsSync(secretDirectory)
    ? readdirSync(secretDirectory)
        .flatMap((name) => {
          const value = readFileSync(
            join(secretDirectory, name),
            'utf8',
          ).replace(/\r?\n$/, '');
          return value ? [value, encodeURIComponent(value)] : [];
        })
        .sort((a, b) => b.length - a.length)
    : [];
  const sanitize = (value: string): string => {
    for (const secret of secrets)
      value = value.replaceAll(secret, '[REDACTED]');
    return value.replace(/(\w+:\/\/)[^\s/@]+:[^\s/@]+@/g, '$1[REDACTED]@');
  };
  const commands: { code: number; timedOut: boolean; cleanup: boolean }[] = [];
  return {
    logPath,
    record(result: CommandResult, cleanup: boolean): void {
      commands.push({ code: result.code, timedOut: result.timedOut, cleanup });
      appendFileSync(
        logPath,
        sanitize(
          `Command ${String(commands.length)}${cleanup ? ' (cleanup)' : ''}: exit ${String(result.code)}\n${result.stdout}\n${result.stderr}\n`,
        ),
        { mode: 0o600 },
      );
    },
    finish(code: number): void {
      writeJson(join(path, 'result.json'), { operation, code, commands });
    },
  };
}

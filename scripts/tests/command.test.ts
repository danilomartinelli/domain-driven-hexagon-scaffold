import { expect, test } from 'bun:test';
import { runCommand } from '../lib/command';
import { withCleanup } from './cleanup';

for (const leaderIgnoresSignal of [true, false]) {
  test(`cancellation stops descendants and prevents later commands when leader ignores signal: ${String(leaderIgnoresSignal)}`, async () => {
    const controller = new AbortController();
    const interrupt = setTimeout(() => {
      controller.abort('SIGTERM');
    }, 500);
    let descendant = 0;
    await withCleanup(async () => {
      const result = await runCommand(
        [
          process.execPath,
          '-e',
          `
      ${leaderIgnoresSignal ? "process.on('SIGTERM', () => {});" : ''}
      const child = Bun.spawn([process.execPath, '-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' });
      console.log(child.pid);
      setInterval(() => {}, 1000);
      `,
        ],
        {
          cwd: process.cwd(),
          timeout: 5_000,
          cancellation: { signal: controller.signal, graceMs: 100 },
        },
      );
      expect(result.code).toBe(143);
      expect(result.timedOut).toBe(false);
      descendant = Number(result.stdout.trim());
      expect(descendant).toBeGreaterThan(0);
      await Bun.sleep(50);
      expect(() => process.kill(descendant, 0)).toThrow();
      const skipped = await runCommand(
        [process.execPath, '-e', "console.log('started')"],
        {
          cwd: process.cwd(),
          cancellation: { signal: controller.signal, graceMs: 100 },
        },
      );
      expect(skipped.code).toBe(143);
      expect(skipped.stdout).toBe('');
    }, [
      () => {
        clearTimeout(interrupt);
      },
      () => {
        if (descendant <= 0) return;
        try {
          process.kill(descendant, 'SIGKILL');
        } catch (error) {
          if (!(
            error instanceof Error &&
            'code' in error &&
            error.code === 'ESRCH'
          ))
            throw error;
        }
      },
    ]);
  }, 10_000);
}

for (const code of [129, 130, 143]) {
  test(`operator interruption terminates the active command and preserves status ${String(code)}`, async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(code);
    }, 100);
    try {
      const result = await runCommand(
        [process.execPath, '-e', 'setInterval(() => {}, 1000)'],
        { cwd: process.cwd(), timeout: 1000, signal: controller.signal },
      );
      expect(result.code).toBe(code);
      expect(result.timedOut).toBe(false);
    } finally {
      clearTimeout(timer);
    }
  });
}

test('long command diagnostics expose progress and the existing log without echoing arguments', async () => {
  const result = await runCommand(
    [
      process.execPath,
      '-e',
      `
      import { runCommand } from ${JSON.stringify(new URL('../lib/command.ts', import.meta.url).pathname)};
      const result = await runCommand([process.execPath, '-e', "setInterval(() => {}, 1000)", 'private-argument'], {
        cwd: process.cwd(), timeout: 150,
        progress: { label: 'prepared E2E', logPath: '.context/test-runs/probe/run.log', intervalMs: 20 }
      });
      console.error(result.stderr);
      process.exitCode = result.code;
    `,
    ],
    { cwd: process.cwd(), timeout: 5_000 },
  );
  expect(result.code).toBe(124);
  expect(result.stderr).toContain('[command:started] prepared E2E');
  expect(result.stderr).toContain('[command:running] prepared E2E');
  expect(result.stderr).toContain('timed out after 150 ms');
  expect(result.stderr).toContain('.context/test-runs/probe/run.log');
  expect(result.stderr).not.toContain('private-argument');
});

test('a command deadline terminates its descendants and reports timeout', async () => {
  const result = await runCommand(
    [
      process.execPath,
      '-e',
      `
      const child = Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 1000)']);
      console.log(child.pid);
      setInterval(() => {}, 1000);
    `,
    ],
    { cwd: process.cwd(), timeout: 500 },
  );
  expect(result.timedOut).toBe(true);
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain('timed out after 500 ms');
  expect(result.stderr).toContain(process.execPath);
  const descendant = Number(result.stdout.trim());
  expect(descendant).toBeGreaterThan(0);
  // A reaped descendant cannot keep the command's pipes or later checks alive.
  await Bun.sleep(50);
  expect(() => process.kill(descendant, 0)).toThrow();
}, 5_000);

test('excessive output fails explicitly instead of becoming a truncated successful result', async () => {
  const result = await runCommand(
    [
      process.execPath,
      '-e',
      "process.stdout.write('x'.repeat(70_000)); setInterval(() => {}, 1000)",
    ],
    { cwd: process.cwd(), timeout: 5_000 },
  );
  expect(result.code).toBe(125);
  expect(result.timedOut).toBe(false);
  expect(result.stderr).toContain('result is incomplete');
  expect(result.stdout.length).toBeLessThanOrEqual(64_000);
});

test('output overflow still terminates descendants when the producer exits immediately', async () => {
  const result = await runCommand(
    [
      process.execPath,
      '-e',
      `
      const child = Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 1000)'], {
        stdout: 'inherit', stderr: 'inherit',
      });
      console.log(child.pid);
      child.unref();
      process.stdout.write('x'.repeat(70_000));
    `,
    ],
    { cwd: process.cwd(), timeout: 5_000, outputRetention: 'head' },
  );
  expect(result.code).toBe(125);
  expect(result.timedOut).toBe(false);
  const descendant = Number(result.stdout.split('\n')[0]);
  expect(descendant).toBeGreaterThan(0);
  await Bun.sleep(50);
  expect(() => process.kill(descendant, 0)).toThrow();
});

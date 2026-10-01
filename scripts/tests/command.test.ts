import { expect, test } from 'bun:test';
import { runCommand } from '../lib/command';

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

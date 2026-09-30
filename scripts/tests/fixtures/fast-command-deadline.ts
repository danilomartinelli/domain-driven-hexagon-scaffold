import { setTimeout as schedule } from 'node:timers';

// Accelerate only wrapped-command deadlines in the environment CLI subprocess.
// Ownership checks and Docker lifecycle operations keep their real deadlines.
Object.defineProperty(globalThis, 'setTimeout', {
  value: (callback: () => void, delay?: number, ...args: unknown[]) =>
    schedule(
      callback,
      delay === 300_000 || delay === 60_000 ? 100 : delay,
      ...args,
    ),
});

import { expect, test } from 'bun:test';
import { runCommand } from '../lib/command';

test('ordinary OCI startup preserves application-owned HTTP and durable delivery during broker outages', async () => {
  const result = await runCommand(
    [
      'bun',
      'scripts/with-test-database.ts',
      '--app=user',
      '--no-database-setup',
      '--',
      'bun',
      'test',
      '--preload',
      './scripts/tests/fixtures/transient-gateway-timeout.ts',
      './scripts/tests/distribution-user.test.ts',
    ],
    {
      cwd: new URL('../../', import.meta.url).pathname,
      // Leave room for provisioning, the runner's 300 s command and cleanup.
      timeout: 600_000,
      cancellation: { signal: AbortSignal.timeout(480_000), graceMs: 90_000 },
      maxOutput: 2_000_000,
      env: {
        ...process.env,
        DDH_IMAGE_PLATFORM:
          process.env.DDH_IMAGE_PLATFORM ??
          `linux/${process.arch === 'arm64' ? 'arm64' : 'amd64'}`,
      },
    },
  );
  expect(result.stdout).toContain(
    'Injected one application-owned gateway request timeout',
  );
  expect(result.stdout).toContain(
    'Observed usable application-owned HTTP before migrations',
  );
  expect(result.code, result.stdout + result.stderr).toBe(0);
}, 660_000);

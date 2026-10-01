import { expect, test } from 'bun:test';
import { ESLint } from 'eslint';

const eslint = new ESLint();

test.each([
  "runCommand(['docker', 'rm', '-f', 'probe'], { cwd: '.' })",
  "runCommand(['docker', 'container', 'remove', 'probe'], { cwd: '.' })",
  "spawn('docker', ['rm', '-f', 'probe'])",
  "spawn('docker', ['container', 'rm', 'probe'])",
  "exec('docker rm -f probe')",
  "runCommand(['sh', '-c', 'docker container rm probe'], { cwd: '.' })",
  'exec(`docker rm -f ${name}`)',
])('Docker fixtures reject direct container deletion: %s', async (command) => {
  const messages = await restrictions(
    `export function fixture(): void { void ${command}; }`,
    'scripts/tests/environment.test.ts',
  );
  expect(messages).toHaveLength(1);
  expect(messages[0].message).toContain('removeOwnedContainer');
});

test('container removal rules preserve other Docker and Git commands and the owned helper', async () => {
  const source = `export function fixture(): void {
    void runCommand(['docker', 'inspect', 'probe'], { cwd: '.' });
    void runCommand(['docker', 'exec', 'probe', 'rm', 'temporary-file'], { cwd: '.' });
    void runCommand(['git', 'rm', 'file'], { cwd: '.' });
    void removeOwnedContainer({ name: 'probe', owner: 'fixture' });
  }`;
  expect(
    await restrictions(source, 'scripts/tests/environment.test.ts'),
  ).toEqual([]);
  expect(
    await restrictions(
      "export function fixture(): void { void runCommand(['docker', 'rm', 'id'], { cwd: '.' }); }",
      'scripts/tests/owned-container.ts',
    ),
  ).toEqual([]);
});

const asyncFinally = `export async function fixture(): Promise<void> {
  try { await Promise.resolve(); }
  finally { await Promise.reject(new Error('cleanup')); }
}`;

async function restrictions(source: string, filePath: string) {
  const [result] = await eslint.lintText(source, { filePath });
  expect(result.fatalErrorCount, JSON.stringify(result.messages)).toBe(0);
  return result.messages.filter(
    ({ ruleId }) => ruleId === 'no-restricted-syntax',
  );
}

test.each([
  'src/apps/wallet/tests/component/database-ownership.test.ts',
  'tests/integration/user-wallet.test.ts',
  'scripts/tests/environment.test.ts',
  'scripts/tests/test-database-runner.test.ts',
  'scripts/tests/broker.test.ts',
])(
  'rejects awaited finally cleanup in infrastructure fixture %s',
  async (filePath) => {
    const messages = await restrictions(asyncFinally, filePath);
    expect(messages).toHaveLength(1);
    expect(messages[0].message).toContain('withCleanup');
  },
);

test('synchronous fixture cleanup and production finalizers remain allowed', async () => {
  expect(
    await restrictions(
      asyncFinally.replace(
        "await Promise.reject(new Error('cleanup'))",
        'void 0',
      ),
      'src/apps/wallet/tests/component/database-ownership.test.ts',
    ),
  ).toEqual([]);
  expect(
    await restrictions(
      asyncFinally,
      'src/apps/wallet/messaging/rabbit-wallet-consumer.ts',
    ),
  ).toEqual([]);
});

test('fixture overrides retain the shared syntax restrictions', async () => {
  expect(
    await restrictions(
      'export class Fixture { set value(_value: string) {} }',
      'src/apps/wallet/tests/component/database-ownership.test.ts',
    ),
  ).toHaveLength(1);
});

test('withCleanup remains available to infrastructure fixtures', async () => {
  expect(
    await restrictions(
      `import { withCleanup } from '../../../../../scripts/tests/cleanup';
       export async function fixture(): Promise<void> {
         await withCleanup(() => Promise.resolve(), [() => Promise.resolve()]);
       }`,
      'src/apps/wallet/tests/component/database-ownership.test.ts',
    ),
  ).toEqual([]);
});

test.each([
  'src/apps/user/tests/component/publication-recovery.test.ts',
  'src/apps/wallet/tests/component/database-ownership.test.ts',
  'tests/integration/user-wallet.test.ts',
  'scripts/tests/environment.test.ts',
])(
  'rejects sequential awaits inside one cleanup callback in %s',
  async (filePath) => {
    for (const callback of [
      'async () => { await stopUser(); await connection.close(); }',
      'async function () { await stopUser(); await connection.close(); }',
      'async () => { await connection.close(); await stopUser(); }',
      'async () => { await stopUser(); await pool.end(); }',
    ]) {
      const messages = await restrictions(
        `export async function fixture(): Promise<void> {
        await withCleanup(() => Promise.resolve(), [${callback}]);
      }`,
        filePath,
      );
      expect(messages).toHaveLength(1);
      expect(messages[0].message).toContain('withCleanup');
    }
  },
);

test('dependent restore steps stay sequential and resource cleanup uses nested withCleanup', async () => {
  expect(
    await restrictions(
      `export async function fixture(): Promise<void> {
        await withCleanup(async () => {
          await startUser();
          await createUser();
        }, [
          () => withCleanup(stopUser, [() => connection.close()]),
          async () => { await gate.close(); },
          async () => { await stopUser(); await startUser(); },
          async () => { await startBroker(); await waitForBrokerHealth(); },
        ]);
      }`,
      'src/apps/user/tests/component/publication-recovery.test.ts',
    ),
  ).toEqual([]);
});

test('independent queue purges cannot abandon later queues after a failure', async () => {
  const messages = await restrictions(
    `export async function fixture(): Promise<void> {
      await withCleanup(use, [() => withCleanup(async () => {
          for (const queue of ['user.create', 'user.create.failed']) {
            await channel.purgeQueue(queue);
          }
        }, [() => connection.close()])]);
    }`,
    'src/apps/user/tests/component/command-fixture.ts',
  );
  expect(messages).toHaveLength(1);
  expect(messages[0].message).toContain('withCleanup');
});

test('queue setup loops and separately registered purges remain allowed', async () => {
  expect(
    await restrictions(
      `export async function fixture(): Promise<void> {
      await withCleanup(async () => {
        for (const queue of queues) {
          await channel.purgeQueue(queue);
        }
        await use();
      }, queues.map(queue => async () => {
        const cleanupChannel = await connection.createChannel();
        await withCleanup(() => cleanupChannel.purgeQueue(queue), [() => cleanupChannel.close()]);
      }));
    }`,
      'src/apps/user/tests/component/command-fixture.ts',
    ),
  ).toEqual([]);
});

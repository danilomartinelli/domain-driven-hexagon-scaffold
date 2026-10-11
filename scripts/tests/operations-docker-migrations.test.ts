import { rejects } from 'node:assert/strict';
import { expect, test } from 'bun:test';
import { dockerInstallationRuntime } from '../lib/operations-docker-runtime';
import { artifact, installationState } from './installation-runtime-fixture';

const unexpected = (args: string[]) =>
  Promise.reject(new Error(`Unexpected command: ${args.join(' ')}`));

for (const application of ['user', 'wallet']) {
  test(`Docker database startup waits for the selected application ${application}`, async () => {
    const commands: string[][] = [];
    const runtime = dockerInstallationRuntime({
      current: installationState('/unused', [artifact(application)]),
      compose: (args) => {
        commands.push(args);
        return Promise.resolve('');
      },
      execute: unexpected,
      oneShot: (service, command) => unexpected([service, ...command]),
    });
    await runtime.startDatabase(application);
    expect(commands).toEqual([
      ['up', '-d', '--wait', '--wait-timeout', '60', `postgres-${application}`],
    ]);
  });
}

test('Docker database startup rejects when Compose fails', async () => {
  const failure = new Error('postgres-user startup exited 1');
  const runtime = dockerInstallationRuntime({
    current: installationState('/unused', [artifact()]),
    compose: () => Promise.reject(failure),
    execute: unexpected,
    oneShot: (service, command) => unexpected([service, ...command]),
  });
  await rejects(runtime.startDatabase('user'), (error) => error === failure);
});

test('Docker migrations run in the application migration service and reject when the command fails', async () => {
  const target = artifact();
  const failure = new Error('migration:up exited 1');
  const commands: string[][] = [];
  const runtime = dockerInstallationRuntime({
    current: installationState('/unused', [target]),
    compose: unexpected,
    execute: unexpected,
    oneShot: (service, command) => {
      commands.push([service, ...command]);
      return Promise.reject(failure);
    },
  });
  await rejects(runtime.migrate(target), (error) => error === failure);
  expect(commands).toEqual([['migrate-user', 'run', 'migration:up']]);
});

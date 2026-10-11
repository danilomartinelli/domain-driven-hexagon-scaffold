import { rejects } from 'node:assert/strict';
import { expect, test } from 'bun:test';
import { dockerInstallationRuntime } from '../lib/operations-docker-runtime';
import { artifact, installationState } from './installation-runtime-fixture';

test('Docker migrations run in the application migration service and reject when the command fails', async () => {
  const target = artifact();
  const unexpected = (args: string[]) =>
    Promise.reject(new Error(`Unexpected command: ${args.join(' ')}`));
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

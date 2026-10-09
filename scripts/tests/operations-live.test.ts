import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { operationsFixture } from './operations-fixture';
import { withCleanup } from './cleanup';
import { runCommand } from '../lib/command';
import { removeOwnedContainer } from './owned-container';
import { until } from './app-runtime-fixture';
import { z } from 'zod';
import { appWorkspace, generate, run } from './app-generator-fixture';
import { operationsDatabaseFixture } from './operations-database-fixture';
import { availablePort } from '../lib/environments';
import { stateSchema } from '../lib/operations-config';
import { transitionSchema } from '../lib/operations-transition';
import type { DeploymentPlan } from '../lib/operations-plan';
import {
  backupApplication,
  restoreApplication,
  migrationHistory,
  appliedMigrations,
  verifyArchive,
} from '../lib/operations-backup';

test('planning distinguishes an empty migration history from an unreadable running database', async () => {
  const fixture = await operationsDatabaseFixture();
  await withCleanup(async () => {
    expect(await appliedMigrations('user', fixture.compose)).toEqual([
      'baseline',
    ]);
    await fixture.sql('DROP TABLE pgmigrations');
    expect(await appliedMigrations('user', fixture.compose)).toEqual([]);
    await fixture.compose([
      'exec',
      '-T',
      'postgres-user',
      'psql',
      '-X',
      '-U',
      'postgres',
      '-d',
      'user',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      'ALTER ROLE user_owner NOLOGIN',
    ]);
    for (const read of [migrationHistory, appliedMigrations]) {
      const failure = await read('user', fixture.compose).then(
        () => undefined,
        (error: unknown) => error,
      );
      if (!(failure instanceof Error))
        throw new Error(
          'Expected the unreadable database to reject the history query',
        );
      expect(failure.message).toContain('not permitted to log in');
    }
  }, [fixture.cleanup]);
}, 60_000);

async function continueWithoutMigrations(
  fixture: Awaited<ReturnType<typeof operationsFixture>>,
  ...args: string[]
): Promise<string> {
  // Runtime verification must work when the migration-owner credentials are unusable.
  const ownerSecret = join(fixture.directory, 'secrets', 'user-owner-password');
  const password = readFileSync(ownerSecret);
  chmodSync(ownerSecret, 0o644);
  writeFileSync(ownerSecret, 'unusable-migration-owner-password\n');
  return withCleanup(
    () => fixture.ops('continue', 'user', ...args),
    [
      () => {
        writeFileSync(ownerSecret, password);
        chmodSync(ownerSecret, 0o444);
      },
    ],
  );
}

for (const [failure, recovery] of [
  ['process', 'continue'],
  ['http', 'continue'],
  ['process', 'rollback'],
] as const) {
  test(`candidate ${failure} failure stops only the candidate and recovers through ${recovery} without repeating migration`, async () => {
    const fixture = await operationsFixture();
    await withCleanup(async () => {
      await fixture.ops('prepare');
      await fixture.ops('migrate', 'user');
      await fixture.ops('migrate', 'wallet');
      await fixture.ops('start');
      const sibling = await fixture.compose(['ps', '-q', 'app-wallet']);
      const candidate = await fixture.variant(failure);
      const updated = await fixture.opsResult(
        'update',
        'user',
        `--image=${candidate}`,
      );
      expect(updated.code).not.toBe(0);
      const recordPath = join(
        fixture.directory,
        readdirSync(fixture.directory).find((file) =>
          file.startsWith('transition-'),
        ) ?? 'missing',
      );
      const record = () =>
        JSON.parse(readFileSync(recordPath, 'utf8')) as unknown;
      expect(record()).toMatchObject({
        candidateImage: candidate,
        migration: { outcome: 'completed' },
        status: 'verification-failed',
        verification: { outcome: 'failed', reason: `${failure}-failed` },
        runtime: { process: 'exited', image: candidate },
      });
      expect(fixture.state().applied.applications[0]).toMatchObject({
        image: candidate,
        migration: {
          operation: 'update',
          image: candidate,
          result: 'committed',
        },
        startup: {
          operation: 'update',
          image: candidate,
          readiness: 'full',
          result: 'failed',
        },
      });
      expect(
        fixture
          .state()
          .applied.applications.find(
            (entry) => entry.declaration.name === 'user',
          )?.image,
      ).toBe(candidate);
      expect(await fixture.ops('probe', 'user')).toContain(
        '"process":"exited"',
      );
      expect(await fixture.compose(['ps', '-q', 'app-user'])).toBe('');
      expect(
        await fixture.request('/v1/users').catch((error: unknown) => error),
      ).toBeInstanceOf(Error);
      expect(
        await fixture.request('/wallet/graphql', {
          method: 'POST',
          data: { query: '{ __typename }' },
        }),
      ).toMatchObject({ data: { __typename: 'Query' } });
      const history = await migrationHistory('user', fixture.compose);
      expect(history).toContain('1990000000003_candidate');
      const container = await fixture.compose([
        'ps',
        '--all',
        '-q',
        'app-user',
      ]);
      if (failure === 'http') {
        expect(await fixture.compose(['logs', 'app-user'])).toContain(
          'shutdown.completed',
        );
        expect(
          await fixture.execute([
            'docker',
            'inspect',
            '--format',
            '{{.State.ExitCode}}',
            container,
          ]),
        ).toBe('0');
        expect(record()).toMatchObject({
          attempts: [
            {
              runtime: { process: 'running', http: 'not_ready' },
              outcome: 'failed',
            },
          ],
        });
      }
      if (recovery === 'rollback') {
        const receipt = join(fixture.directory, 'compatibility.json');
        writeFileSync(
          receipt,
          JSON.stringify({
            application: 'user',
            currentImage: candidate,
            targetImage: fixture.images.user,
            migrationHistory: history,
            schemaReview:
              'The candidate only added an unused marker table; the original User reads and writes remain compatible.',
            eventContractReview:
              'User and Wallet still exchange the same user.created v1 envelope with unchanged decoders.',
          }),
        );
        await fixture.ops(
          'rollback',
          'user',
          `--image=${fixture.images.user}`,
          `--compatibility=${receipt}`,
        );
        expect(fixture.state().pendingTransitions).toBeUndefined();
        expect(
          fixture
            .state()
            .applied.applications.find(
              (entry) => entry.declaration.name === 'user',
            )?.image,
        ).toBe(fixture.images.user);
      } else {
        if (failure === 'http') {
          await fixture.compose([
            'exec',
            '-T',
            'postgres-user',
            'psql',
            '-U',
            'postgres',
            '-d',
            'user',
            '-v',
            'ON_ERROR_STOP=1',
            '-c',
            'GRANT SELECT ON users TO user_runtime',
          ]);
        } else {
          const marker = join(fixture.directory, 'operations-recover');
          writeFileSync(marker, 'recover');
          await fixture.execute([
            'docker',
            'cp',
            marker,
            `${container}:/tmp/operations-recover`,
          ]);
        }
        const continuationOptions: string[] = [];
        if (failure === 'process') {
          const archive = join(
            fixture.directory,
            'wallet-before-recovery.dump',
          );
          await fixture.ops('backup', 'wallet', `--output=${archive}`);
          await fixture.ops('stop');
          await fixture.ops('restore', 'wallet', `--input=${archive}`);
          const unassessed = await fixture.opsResult('continue', 'user');
          expect(unassessed.code).not.toBe(0);
          expect(unassessed.stderr).toContain('Restore requires --assessment');
          expect(await fixture.compose(['ps', '-q', 'app-user'])).toBe('');
          const restored = z
            .object({
              applications: z.record(z.string(), z.object({ id: z.string() })),
            })
            .parse(
              JSON.parse(
                readFileSync(join(fixture.directory, 'recovery.json'), 'utf8'),
              ),
            );
          const assessment = join(fixture.directory, 'assessment.json');
          writeFileSync(
            assessment,
            JSON.stringify({
              recoveryIds: Object.values(restored.applications).map(
                (entry) => entry.id,
              ),
              dataComparison:
                'The empty Wallet database was restored from its own fresh archive and its migration history is unchanged.',
              messagingReview:
                'This disposable scenario has no pending or retained deliveries; both application contracts are unchanged.',
            }),
          );
          continuationOptions.push(`--assessment=${assessment}`);
        }
        expect(
          await continueWithoutMigrations(fixture, ...continuationOptions),
        ).toContain('verified');
        if (failure === 'process') {
          expect(existsSync(join(fixture.directory, 'recovery.json'))).toBe(
            false,
          );
          expect(await fixture.compose(['ps', '-q', 'app-wallet'])).toBe('');
          await fixture.ops('start', 'wallet');
        }
        expect(record()).toMatchObject({
          status: 'verified',
          verification: { outcome: 'verified' },
        });
        expect(await fixture.compose(['ps', '-q', 'app-user'])).toBe(container);
      }
      expect(await migrationHistory('user', fixture.compose)).toEqual(history);
      expect(fixture.state().applied.applications[0].startup).toMatchObject({
        image: recovery === 'rollback' ? fixture.images.user : candidate,
        readiness: 'full',
        result: 'verified',
      });
      await until(() =>
        fixture.request('/v1/users').then(
          () => true,
          () => false,
        ),
      );
      expect(await fixture.request('/v1/users')).toMatchObject({ count: 0 });
      expect(await fixture.compose(['ps', '-q', 'app-wallet'])).toBe(sibling);
    }, [fixture.cleanup]);
  }, 300_000);
}

test('candidate messaging degradation retains HTTP and requires explicit continuation without migrations', async () => {
  const fixture = await operationsFixture();
  await withCleanup(async () => {
    await fixture.ops('prepare');
    await fixture.ops('migrate', 'user');
    await fixture.ops('migrate', 'wallet');
    await fixture.ops('start');
    const sibling = await fixture.compose(['ps', '-q', 'app-wallet']);
    const candidate = await fixture.variant('compatible');
    await fixture.compose(['stop', 'rabbitmq']);
    const update = await fixture.opsResult(
      'update',
      'user',
      `--image=${candidate}`,
    );
    expect(update.code).not.toBe(0);
    const recordPath = join(
      fixture.directory,
      readdirSync(fixture.directory).find((file) =>
        file.startsWith('transition-'),
      ) ?? 'missing',
    );
    const record = () =>
      JSON.parse(readFileSync(recordPath, 'utf8')) as unknown;
    expect(record()).toMatchObject({
      candidateImage: candidate,
      migration: { outcome: 'completed' },
      status: 'verification-pending',
      verification: { outcome: 'pending', reason: 'messaging-degraded' },
      runtime: { process: 'running', http: 'ready', messaging: 'not_ready' },
    });
    const planned = JSON.parse(await fixture.ops('plan')) as DeploymentPlan;
    expect(planned.applied.applications[0]).toMatchObject({
      application: 'user',
      image: candidate,
      migration: { operation: 'update', image: candidate, result: 'committed' },
      startup: {
        operation: 'update',
        image: candidate,
        readiness: 'full',
        result: 'pending',
      },
    });
    await until(() =>
      fixture.request('/v1/users').then(
        () => true,
        () => false,
      ),
    );
    expect(await fixture.request('/v1/users')).toMatchObject({ count: 0 });
    expect(await fixture.ops('probe', 'user')).toContain(
      'messaging_unavailable',
    );
    const container = await fixture.compose(['ps', '-q', 'app-user']);
    const history = await migrationHistory('user', fixture.compose);
    expect(history).toContain('1990000000000_operations-compatible');
    const blocked = await fixture.opsResult(
      'update',
      'user',
      `--image=${candidate}`,
    );
    expect(blocked.code).not.toBe(0);
    expect(blocked.stderr).toContain('Continue or roll back');
    await fixture.compose(['start', 'rabbitmq']);
    await fixture.ops('update', 'wallet', `--image=${fixture.images.wallet}`);
    expect(await fixture.compose(['ps', '-q', 'app-user'])).toBe(container);
    // Automatic transport recovery must not silently finish the operator transition.
    await until(
      async () => !(await fixture.ops('probe', 'user')).includes('not_ready'),
    );
    expect(record()).toMatchObject({ status: 'verification-pending' });
    const continued = await continueWithoutMigrations(fixture);
    expect(continued).toContain('verified');
    expect(fixture.state().applied.applications[0].startup).toMatchObject({
      operation: 'update',
      image: candidate,
      readiness: 'full',
      result: 'verified',
    });
    expect(record()).toMatchObject({
      status: 'verified',
      verification: { outcome: 'verified' },
    });
    expect(await migrationHistory('user', fixture.compose)).toEqual(history);
    expect(await fixture.compose(['ps', '-q', 'app-user'])).toBe(container);
    expect(await fixture.compose(['ps', '-q', 'app-wallet'])).toBe(sibling);
  }, [fixture.cleanup]);
}, 300_000);

for (const foreignKey of [false, true]) {
  test(`restore removes post-backup schema changes (foreign key: ${String(foreignKey)})`, async () => {
    const fixture = await operationsDatabaseFixture();
    await withCleanup(async () => {
      const backup = join(fixture.directory, 'user.dump');
      await backupApplication(
        fixture.state,
        fixture.app,
        backup,
        fixture.compose,
      );
      const migration = `CREATE TABLE operations_marker (id integer${foreignKey ? ' REFERENCES users(id)' : ''}); INSERT INTO operations_marker VALUES (1); INSERT INTO pgmigrations VALUES (2, 'later');`;
      await fixture.sql(migration);
      await fixture.sql('INSERT INTO users VALUES (2)');
      await restoreApplication(
        fixture.state,
        fixture.app,
        await verifyArchive(
          fixture.state,
          fixture.app,
          backup,
          fixture.compose,
        ),
        fixture.compose,
      );
      expect(
        await fixture.sql(
          "SELECT to_regclass('public.operations_marker') IS NULL",
        ),
      ).toBe('t');
      expect(await fixture.sql('SELECT id FROM users ORDER BY id')).toBe('1');
      expect(await migrationHistory('user', fixture.compose)).toEqual([
        'baseline',
      ]);
      expect(
        await fixture.sql(
          "SELECT has_table_privilege('user_runtime', 'users', 'SELECT')",
        ),
      ).toBe('t');
      expect(
        await fixture.sql(
          "SELECT has_schema_privilege('user_runtime', 'public', 'USAGE')",
        ),
      ).toBe('t');
      await fixture.sql(migration);
      expect(await migrationHistory('user', fixture.compose)).toEqual([
        'baseline',
        'later',
      ]);
      const repeated = join(fixture.directory, 'repeated.dump');
      await backupApplication(
        fixture.state,
        fixture.app,
        repeated,
        fixture.compose,
      );
      await restoreApplication(
        fixture.state,
        fixture.app,
        await verifyArchive(
          fixture.state,
          fixture.app,
          repeated,
          fixture.compose,
        ),
        fixture.compose,
      );
      expect(await migrationHistory('user', fixture.compose)).toEqual([
        'baseline',
        'later',
      ]);
    }, [fixture.cleanup]);
  }, 60_000);
}

test('restore rolls back schema cleanup and data when archive SQL fails', async () => {
  const fixture = await operationsDatabaseFixture();
  await withCleanup(async () => {
    const backup = join(fixture.directory, 'user.dump');
    await backupApplication(
      fixture.state,
      fixture.app,
      backup,
      fixture.compose,
    );
    await fixture.sql(
      'CREATE TABLE operations_marker (id integer); INSERT INTO operations_marker VALUES (9); INSERT INTO users VALUES (2);',
    );
    // Make the archive ACL fail after tables and data have been restored.
    await fixture.compose([
      'exec',
      '-T',
      'postgres-user',
      'psql',
      '-X',
      '-U',
      'postgres',
      '-d',
      'user',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      'DROP OWNED BY user_runtime; DROP ROLE user_runtime;',
    ]);
    const failure = await restoreApplication(
      fixture.state,
      fixture.app,
      await verifyArchive(fixture.state, fixture.app, backup, fixture.compose),
      fixture.compose,
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    if (!(failure instanceof Error))
      throw new Error('Expected archive SQL failure');
    expect(failure.message).toContain('user_runtime');
    expect(await fixture.sql('SELECT id FROM users ORDER BY id')).toBe('1\n2');
    expect(await fixture.sql('SELECT id FROM operations_marker')).toBe('9');
    expect(
      JSON.parse(
        readFileSync(join(fixture.directory, 'recovery.json'), 'utf8'),
      ),
    ).toMatchObject({ applications: { user: { status: 'restoring' } } });
    expect(
      await fixture.compose([
        'exec',
        '-T',
        'postgres-user',
        'sh',
        '-ec',
        'find /tmp -name "operations-*"',
      ]),
    ).toBe('');
  }, [fixture.cleanup]);
}, 60_000);

test('operators can start HTTP service while the broker is unavailable', async () => {
  const fixture = await operationsFixture();
  await withCleanup(async () => {
    await fixture.ops('prepare');
    await fixture.ops('migrate', 'user');
    await fixture.compose(['stop', 'rabbitmq']);
    const started = await fixture.opsResult('start', 'user');
    expect(started.code, started.stderr).toBe(0);
    await until(async () =>
      fixture.request('/v1/users').then(
        () => true,
        () => false,
      ),
    );
    expect(await fixture.request('/v1/users')).toMatchObject({ count: 0 });
    expect(await fixture.ops('probe', 'user')).toContain(
      'messaging_unavailable',
    );
  }, [fixture.cleanup]);
}, 300_000);

test('operators bootstrap digest-selected HTTPS applications and repeat preparation without losing credentials or data', async () => {
  const fixture = await operationsFixture();
  await withCleanup(async () => {
    const sql = (app: string, query: string) =>
      fixture.compose([
        'exec',
        '-T',
        `postgres-${app}`,
        'psql',
        '-U',
        'postgres',
        '-d',
        app,
        '-At',
        '-c',
        query,
      ]);
    const incompatible = await fixture.variant('incompatible');
    const rejectedContainer = {
      name: `ddh-incompatible-${randomUUID()}`,
      owner: randomUUID(),
    };
    await withCleanup(async () => {
      const startup = await runCommand(
        [
          'docker',
          'run',
          '--rm',
          '--network=none',
          '--read-only',
          `--name=${rejectedContainer.name}`,
          `--label=dev.starter.owner=${rejectedContainer.owner}`,
          '--entrypoint=bun',
          incompatible,
          '--no-env-file',
          'run',
          'start',
        ],
        { cwd: fixture.directory, timeout: 30_000 },
      );
      expect(startup.code).not.toBe(0);
      expect(startup.stderr).toContain('user-profile requires persistence');
    }, [() => removeOwnedContainer(rejectedContainer)]);
    const deploymentPath = join(fixture.directory, 'deployment.json');
    const originalDeployment = readFileSync(deploymentPath, 'utf8');
    const desired = JSON.parse(originalDeployment) as {
      images: Record<string, string>;
    };
    desired.images.user = incompatible;
    writeFileSync(deploymentPath, JSON.stringify(desired));
    const rejectedPreparation = await fixture.opsResult('prepare');
    expect(rejectedPreparation.code).not.toBe(0);
    expect(rejectedPreparation.stderr).toContain(
      'user-profile requires persistence',
    );
    expect(existsSync(join(fixture.directory, 'state.json'))).toBe(false);
    expect(existsSync(join(fixture.directory, 'compose.json'))).toBe(false);
    writeFileSync(deploymentPath, originalDeployment);
    for (const key of [
      'user-admin-password',
      'user-owner-password',
      'user-runtime-password',
      'broker-password',
    ]) {
      const file = join(fixture.directory, 'secrets', key);
      const original = readFileSync(file, 'utf8');
      chmodSync(file, 0o644);
      try {
        for (const ending of ['\r\n', '\n\n']) {
          writeFileSync(file, original.trimEnd() + ending);
          const refused = await fixture.opsResult('prepare');
          expect(refused.code).not.toBe(0);
          expect(refused.stderr).toContain(`Invalid password file: ${key}`);
          expect(refused.stderr).not.toContain(original.trimEnd());
          expect(existsSync(join(fixture.directory, 'state.json'))).toBe(false);
        }
      } finally {
        writeFileSync(file, original);
        chmodSync(file, 0o444);
      }
    }
    await fixture.ops('prepare');
    expect(await fixture.ops('status', 'user')).toContain('pending');
    expect((await fixture.opsResult('start')).code).not.toBe(0);
    for (const app of ['user', 'wallet']) await fixture.ops('migrate', app);
    await fixture.ops('start');
    expect(
      await fixture.compose(['exec', '-T', 'app-user', 'ls', '/run/secrets']),
    ).toBe('broker-password\nuser-runtime-password');
    for (const app of ['user', 'wallet']) {
      expect(
        await sql(
          app,
          `SELECT rolsuper OR rolcreatedb OR rolcreaterole FROM pg_roles WHERE rolname = '${app}_runtime'`,
        ),
      ).toBe('f');
      const id = await fixture.compose(['ps', '-q', `app-${app}`]);
      expect(
        await fixture.execute([
          'docker',
          'inspect',
          '--format',
          '{{json .HostConfig.PortBindings}}',
          id,
        ]),
      ).toBe('{}');
    }
    expect(
      await fixture.request('/health/ready').then(
        () => false,
        () => true,
      ),
    ).toBe(true);
    const wrongOwner = await fixture
      .execute([
        'docker',
        'compose',
        '-p',
        fixture.state().project,
        '-f',
        join(fixture.directory, 'compose.json'),
        'run',
        '--rm',
        '--no-deps',
        '-e',
        'DATABASE_APP=wallet',
        'migrate-user',
        'run',
        'migration:status',
      ])
      .then(
        () => false,
        () => true,
      );
    expect(wrongOwner).toBe(true);
    const runtimeMigration = await fixture
      .execute([
        'docker',
        'compose',
        '-p',
        fixture.state().project,
        '-f',
        join(fixture.directory, 'compose.json'),
        'run',
        '--rm',
        '--no-deps',
        '-e',
        'USER_DB_MIGRATION_USERNAME=user_runtime',
        'migrate-user',
        'run',
        'migration:up',
      ])
      .then(
        () => false,
        () => true,
      );
    expect(runtimeMigration).toBe(true);
    const profile = {
      email: 'operations@example.com',
      country: 'England',
      street: 'Baker street',
      postalCode: 'NW16XE',
    };
    await fixture.request('/v1/users', { method: 'POST', data: profile });
    const before = await fixture.request('/v1/users');
    const userId = z
      .object({ data: z.array(z.object({ id: z.string() })) })
      .parse(before).data[0].id;
    await until(async () =>
      fixture.request(`/v1/wallets/by-user/${userId}`).then(
        () => true,
        () => false,
      ),
    );
    const walletBefore = await fixture.request(`/v1/wallets/by-user/${userId}`);
    const userRows = await sql(
      'user',
      'SELECT row_to_json(users) FROM users ORDER BY id',
    );
    const owner = readFileSync(
      join(fixture.directory, 'secrets/user-owner-password'),
      'utf8',
    );
    const inventoryPath = join(fixture.directory, 'state.json');
    const composePath = join(fixture.directory, 'compose.json');
    const inventoryBefore = readFileSync(inventoryPath, 'utf8');
    const composeBefore = readFileSync(composePath, 'utf8');
    const containersBefore = await fixture.compose(['ps', '-q']);
    await until(
      async () =>
        (await sql(
          'user',
          'SELECT count(*) FROM user_outbox WHERE published_at IS NULL',
        )) === '0',
    );
    const outboxBefore = await sql(
      'user',
      'SELECT row_to_json(user_outbox) FROM user_outbox ORDER BY event_id',
    );
    const queueCommand = [
      'exec',
      '-T',
      'rabbitmq',
      'rabbitmqctl',
      'list_queues',
      '--quiet',
      'name',
      'messages',
      '--formatter',
      'json',
    ];
    const queuesBefore = await fixture.compose(queueCommand);
    const rejectedUpdate = await fixture.opsResult(
      'update',
      'user',
      `--image=${incompatible}`,
    );
    expect(rejectedUpdate.code).not.toBe(0);
    expect(rejectedUpdate.stderr).toContain(
      'user-profile requires persistence',
    );
    expect(rejectedUpdate.stderr).not.toContain(owner.trim());
    expect(readFileSync(inventoryPath, 'utf8')).toBe(inventoryBefore);
    expect(readFileSync(composePath, 'utf8')).toBe(composeBefore);
    expect(await fixture.compose(['ps', '-q'])).toBe(containersBefore);
    expect(
      await sql('user', 'SELECT row_to_json(users) FROM users ORDER BY id'),
    ).toBe(userRows);
    expect(
      await sql(
        'user',
        'SELECT row_to_json(user_outbox) FROM user_outbox ORDER BY event_id',
      ),
    ).toBe(outboxBefore);
    expect(await fixture.compose(queueCommand)).toBe(queuesBefore);
    await fixture.ops('prepare');
    expect(
      readFileSync(
        join(fixture.directory, 'secrets/user-owner-password'),
        'utf8',
      ),
    ).toBe(owner);
    expect(await fixture.request('/v1/users')).toEqual(before);
    expect(await fixture.ops('probe', 'user')).toContain('available');
    const published = await fixture.compose(['ps', '--format', 'json']);
    expect(published).not.toContain('0.0.0.0:5432');
    const backup = join(fixture.directory, 'user.dump');
    await fixture.ops('backup', 'user', `--output=${backup}`);
    const walletBackup = join(fixture.directory, 'wallet.dump');
    await fixture.ops('backup', 'wallet', `--output=${walletBackup}`);
    await fixture.request('/v1/users', {
      method: 'POST',
      data: { ...profile, email: 'after-backup@example.com' },
    });
    expect(await fixture.request('/v1/users')).not.toEqual(before);
    await fixture.ops('stop');
    // A checksum-valid but invalid archive fails inside the real pg_restore process.
    const invalidBackup = join(fixture.directory, 'invalid-user.dump');
    const invalidBytes = 'not a PostgreSQL archive';
    writeFileSync(invalidBackup, invalidBytes);
    writeFileSync(
      `${invalidBackup}.json`,
      JSON.stringify({
        ...(JSON.parse(readFileSync(`${backup}.json`, 'utf8')) as object),
        sha256: createHash('sha256').update(invalidBytes).digest('hex'),
      }),
    );
    const schemaOutcome = (app: string) =>
      fixture
        .state()
        .applied.applications.find((entry) => entry.declaration.name === app)
        ?.migration;
    const migrated = schemaOutcome('user');
    expect(migrated).toMatchObject({
      operation: 'migrate',
      image: fixture.images.user,
      result: 'committed',
    });
    // A refused archive opens no recovery gate and keeps the recorded outcome.
    const foreignArchive = await fixture.opsResult(
      'restore',
      'user',
      `--input=${walletBackup}`,
    );
    expect(foreignArchive.code).not.toBe(0);
    expect(foreignArchive.stderr).toContain(
      'Backup ownership or checksum does not match',
    );
    expect(schemaOutcome('user')).toEqual(migrated);
    expect(existsSync(join(fixture.directory, 'recovery.json'))).toBe(false);
    expect(
      (await fixture.opsResult('restore', 'user', `--input=${invalidBackup}`))
        .code,
    ).not.toBe(0);
    expect(schemaOutcome('user')).toMatchObject({
      operation: 'restore',
      image: fixture.images.user,
      result: 'failed',
    });
    await fixture.ops('restore', 'wallet', `--input=${walletBackup}`);
    expect(schemaOutcome('wallet')).toMatchObject({
      operation: 'restore',
      image: fixture.images.wallet,
      result: 'restored',
    });
    const pending = z
      .object({
        applications: z.record(
          z.string(),
          z.object({ id: z.string(), status: z.string() }),
        ),
      })
      .parse(
        JSON.parse(
          readFileSync(join(fixture.directory, 'recovery.json'), 'utf8'),
        ),
      );
    expect(pending.applications.user.status).toBe('restoring');
    expect(pending.applications.wallet.status).toBe('restored');
    const incompleteAssessment = join(
      fixture.directory,
      'incomplete-assessment.json',
    );
    writeFileSync(
      incompleteAssessment,
      JSON.stringify({
        recoveryIds: [pending.applications.wallet.id],
        dataComparison:
          'Only Wallet was restored successfully; User remains unresolved.',
        messagingReview:
          'Unchanged broker state; no purge or replay during restoration.',
      }),
    );
    expect(
      (await fixture.opsResult('start', `--assessment=${incompleteAssessment}`))
        .code,
    ).not.toBe(0);
    expect(
      await fixture.compose([
        'ps',
        '--status',
        'running',
        '--quiet',
        'app-user',
        'app-wallet',
      ]),
    ).toBe('');
    await fixture.ops('restore', 'user', `--input=${backup}`);
    expect(schemaOutcome('user')).toMatchObject({
      operation: 'restore',
      result: 'restored',
    });
    expect(
      await sql('user', 'SELECT row_to_json(users) FROM users ORDER BY id'),
    ).toBe(userRows);
    expect((await fixture.opsResult('start')).code).not.toBe(0);
    const recovery = z
      .object({
        applications: z.record(z.string(), z.object({ id: z.string() })),
      })
      .parse(
        JSON.parse(
          readFileSync(join(fixture.directory, 'recovery.json'), 'utf8'),
        ),
      );
    const assessment = join(fixture.directory, 'assessment.json');
    writeFileSync(
      assessment,
      JSON.stringify({
        recoveryIds: Object.values(recovery.applications).map(
          (entry) => entry.id,
        ),
        dataComparison:
          'Restored database rows match the saved backup; API comparison follows private startup.',
        messagingReview:
          'RabbitMQ retained; User outbox can republish old event identities, Wallet deduplication remains intact. No purge.',
      }),
    );
    await fixture.ops('start', `--assessment=${assessment}`);
    expect(await fixture.request('/v1/users')).toEqual(before);
    expect(await fixture.request(`/v1/wallets/by-user/${userId}`)).toEqual(
      walletBefore,
    );
    const walletContainer = await fixture.compose(['ps', '-q', 'app-wallet']);
    const compatible = await fixture.variant('compatible');
    const gatewayContainer = await fixture.compose(['ps', '-q', 'gateway']);
    writeFileSync(
      deploymentPath,
      JSON.stringify({
        ...(JSON.parse(originalDeployment) as object),
        images: { ...fixture.images, user: compatible },
      }),
    );
    const imagePlan = JSON.parse(await fixture.ops('plan')) as DeploymentPlan;
    expect(imagePlan.changes.capabilities).toEqual([]);
    expect(imagePlan.changes.ingress).toBeNull();
    expect(imagePlan.services.recreate).toEqual(['app-user', 'gateway']);
    expect(imagePlan.interruptions).toContainEqual({
      service: 'gateway',
      effect: 'Recreated; every exposed route is briefly unavailable',
    });
    expect(await fixture.compose(['ps', '-q', 'gateway'])).toBe(
      gatewayContainer,
    );
    await fixture.ops('update', 'user', `--image=${compatible}`);
    expect(await fixture.compose(['ps', '-q', 'gateway'])).not.toBe(
      gatewayContainer,
    );
    expect(
      fixture
        .state()
        .applied.applications.find((entry) => entry.declaration.name === 'user')
        ?.image,
    ).toBe(compatible);
    const appliedUser = () =>
      fixture
        .state()
        .applied.applications.find(
          (entry) => entry.declaration.name === 'user',
        );
    // Image commands keep the desired selection coherent with their request;
    // separately recorded outcomes state whether it was applied.
    const desiredUser = () =>
      z
        .object({ images: z.record(z.string(), z.string()) })
        .parse(JSON.parse(readFileSync(deploymentPath, 'utf8'))).images.user;
    expect(desiredUser()).toBe(compatible);
    expect(appliedUser()).toMatchObject({
      migration: {
        operation: 'update',
        image: compatible,
        result: 'committed',
      },
      startup: {
        operation: 'update',
        image: compatible,
        readiness: 'full',
        result: 'verified',
      },
    });
    expect(await fixture.compose(['ps', '-q', 'app-wallet'])).toBe(
      walletContainer,
    );
    const event = {
      type: 'user.created',
      version: 1,
      source: 'user',
      eventId: randomUUID(),
      occurredAt: new Date().toISOString(),
      correlationId: 'operations-replay',
      causationId: 'operations-test',
      data: { userId: randomUUID() },
    };
    await fixture.compose([
      'exec',
      '-T',
      'app-wallet',
      'bun',
      '-e',
      `import {connect} from 'amqplib'; import {configurationValue} from '@starter/nest-support/configuration'; const c=await connect({hostname:process.env.RABBITMQ_HOST,port:5672,username:process.env.RABBITMQ_USERNAME,password:configurationValue('RABBITMQ_PASSWORD'),vhost:process.env.RABBITMQ_VHOST}); const ch=await c.createConfirmChannel(); ch.sendToQueue('wallet.user-created.failed',Buffer.from(JSON.stringify(${JSON.stringify(event)})),{persistent:true,messageId:${JSON.stringify(event.eventId)},correlationId:'operations-replay'});await ch.waitForConfirms();await c.close();`,
    ]);
    const inspection = z
      .object({
        messages: z.array(
          z.object({
            receipt: z.string(),
            messageId: z.string(),
            correlationId: z.string(),
          }),
        ),
      })
      .parse(JSON.parse(await fixture.ops('inspect', 'wallet')));
    expect(inspection.messages[0]).toMatchObject({
      messageId: event.eventId,
      correlationId: event.correlationId,
    });
    expect(await fixture.ops('inspect', 'wallet')).toContain(
      inspection.messages[0].receipt,
    );
    expect(
      await fixture.ops(
        'replay',
        'wallet',
        `--message=${inspection.messages[0].receipt}`,
      ),
    ).toContain('broker-accepted');
    await until(async () =>
      fixture.request(`/v1/wallets/by-user/${event.data.userId}`).then(
        () => true,
        () => false,
      ),
    );
    expect(
      await sql(
        'wallet',
        `SELECT count(*) FROM wallet_consumed_events WHERE event_id = '${event.eventId}'`,
      ),
    ).toBe('1');
    expect(await fixture.compose(['logs', 'app-wallet'])).toContain(
      event.correlationId,
    );
    await fixture.compose(['stop', 'rabbitmq']);
    expect(await fixture.request('/v1/users')).toEqual(before);
    await fixture.compose(['start', 'rabbitmq']);
    await fixture.compose(['stop', 'postgres-user']);
    await until(async () =>
      (await fixture.ops('probe', 'user')).includes('"status":"unavailable"'),
    );
    const unavailable = await fixture.ops('probe', 'user');
    expect(unavailable).not.toContain('"pendingCount":0');
    await fixture.compose(['start', 'postgres-user']);
    await until(async () =>
      fixture.request('/v1/users').then(
        () => true,
        () => false,
      ),
    );
    expect(await fixture.request('/v1/users')).toEqual(before);
    const failing = await fixture.variant('failure');
    const failedUpdate = await fixture.opsResult(
      'update',
      'user',
      `--image=${failing}`,
    );
    expect(failedUpdate.code).not.toBe(0);
    const evidencePath = /Diagnostic: (.+\/run.log)/.exec(
      failedUpdate.stderr,
    )?.[1];
    expect(evidencePath).toBeDefined();
    expect(readFileSync(evidencePath ?? '', 'utf8')).toContain(
      'division by zero',
    );
    expect(desiredUser()).toBe(failing);
    expect(appliedUser()).toMatchObject({
      image: compatible,
      migration: { operation: 'update', image: failing, result: 'failed' },
      startup: { operation: 'update', image: compatible, result: 'verified' },
    });
    expect(
      await fixture.compose([
        'exec',
        '-T',
        'postgres-user',
        'psql',
        '-U',
        'postgres',
        '-d',
        'user',
        '-At',
        '-c',
        "SELECT count(*) FROM pg_tables WHERE tablename = 'operations_partial'",
      ]),
    ).toBe('0');
    expect(
      (
        await fixture.opsResult(
          'rollback',
          'user',
          `--image=${fixture.images.user}`,
        )
      ).code,
    ).not.toBe(0);
    const interruptedImage = await fixture.variant('interrupted');
    for (const [signal, code] of [
      ['SIGINT', 130],
      ['SIGTERM', 143],
      ['SIGHUP', 129],
    ] as const) {
      const updater = Bun.spawn(
        [
          'bun',
          '--no-env-file',
          'scripts/operations.ts',
          `--directory=${fixture.directory}`,
          'update',
          'user',
          `--image=${interruptedImage}`,
        ],
        { stdout: 'pipe', stderr: 'pipe' },
      );
      const output = Promise.all([
        new Response(updater.stdout).text(),
        new Response(updater.stderr).text(),
      ]);
      try {
        await until(
          async () =>
            (await sql(
              'user',
              "SELECT count(*) FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND wait_event = 'PgSleep'",
            )) === '1',
        );
        updater.kill(signal);
        expect(await updater.exited).toBe(code);
        expect(
          await fixture.compose(['ps', '--all', '--format', '{{.Name}}']),
        ).not.toContain('-command-');
        expect(appliedUser()).toMatchObject({
          image: compatible,
          migration: { image: interruptedImage, result: 'interrupted' },
        });
        expect(desiredUser()).toBe(interruptedImage);
        const transitions = readdirSync(fixture.directory)
          .filter((file) => file.startsWith('transition-'))
          .map((file) =>
            transitionSchema.parse(
              JSON.parse(readFileSync(join(fixture.directory, file), 'utf8')),
            ),
          )
          .filter((record) => record.candidateImage === interruptedImage);
        expect(transitions.length).toBeGreaterThan(0);
        for (const transition of transitions)
          expect(transition).toMatchObject({
            status: 'interrupted',
            migration: { outcome: 'interrupted', completedAt: null },
          });
      } finally {
        if (updater.exitCode === null) updater.kill('SIGTERM');
        await updater.exited;
        await output;
      }
    }
    const receipt = join(fixture.directory, 'compatibility.json');
    const history = (
      await fixture.compose([
        'exec',
        '-T',
        'postgres-user',
        'psql',
        '-U',
        'postgres',
        '-d',
        'user',
        '-At',
        '-c',
        'SELECT name FROM pgmigrations ORDER BY id',
      ])
    ).split('\n');
    writeFileSync(
      receipt,
      JSON.stringify({
        application: 'user',
        currentImage: compatible,
        targetImage: fixture.images.user,
        migrationHistory: history,
        schemaReview:
          'Only the unused operations_marker table was added; baseline readers and writers remain compatible.',
        eventContractReview:
          'Both artifacts use unchanged user.created v1 envelopes and identical pending/retained decoders.',
      }),
    );
    await fixture.ops(
      'rollback',
      'user',
      `--image=${fixture.images.user}`,
      `--compatibility=${receipt}`,
    );
    expect(desiredUser()).toBe(fixture.images.user);
    expect(appliedUser()).toMatchObject({
      image: fixture.images.user,
      startup: {
        operation: 'rollback',
        image: fixture.images.user,
        readiness: 'full',
        result: 'verified',
      },
    });
    expect(await fixture.request('/v1/users')).toEqual(before);
    expect(await fixture.compose(['ps', '-q', 'app-wallet'])).toBe(
      walletContainer,
    );
    const workspace = await appWorkspace();
    const emptyDirectory = join(fixture.directory, 'empty');
    const tag = `127.0.0.1:${String(fixture.registryPort)}/ops-empty:baseline`;
    await withCleanup(async () => {
      await run(
        workspace,
        generate(
          'ops-empty',
          '--persistence=false',
          '--messaging=false',
          '--exposure=false',
        ),
      );
      await run(
        workspace,
        ['bun', 'scripts/image.ts', 'ops-empty', `--tag=${tag}`],
        { timeout: 300_000 },
      );
      fixture.tags.push(tag);
      const image = await fixture.digest(tag);
      mkdirSync(emptyDirectory);
      writeFileSync(
        join(emptyDirectory, 'deployment.json'),
        JSON.stringify({ name: 'empty', images: { 'ops-empty': image } }),
      );
      const command = (action: string) =>
        fixture.execute([
          'bun',
          'run',
          'ops',
          `--directory=${emptyDirectory}`,
          action,
        ]);
      await withCleanup(async () => {
        await command('prepare');
        await command('start');
        expect(
          await fixture.execute([
            'bun',
            'run',
            'ops',
            `--directory=${emptyDirectory}`,
            'probe',
            'ops-empty',
          ]),
        ).toContain('not_applicable');
        const rendered = z
          .object({
            services: z.record(z.string(), z.unknown()),
            secrets: z.record(z.string(), z.unknown()),
          })
          .parse(
            JSON.parse(
              readFileSync(join(emptyDirectory, 'compose.json'), 'utf8'),
            ),
          );
        expect(Object.keys(rendered.services)).toEqual(['app-ops-empty']);
        expect(Object.keys(rendered.secrets)).toEqual([]);
      }, [() => command('down')]);
    }, [workspace.cleanup]);
    console.log(`Operations evidence: ${fixture.directory}`);
  }, [fixture.cleanup]);
}, 600_000);

test('generated messaging applications require their own validated recovery interface', async () => {
  const fixture = await operationsFixture();
  await withCleanup(async () => {
    const workspace = await appWorkspace();
    await withCleanup(async () => {
      await run(
        workspace,
        generate(
          'ops-messenger',
          '--persistence=false',
          '--messaging=true',
          '--exposure=false',
        ),
      );
      const tag = `127.0.0.1:${String(fixture.registryPort)}/ops-messenger:baseline`;
      await run(
        workspace,
        ['bun', 'scripts/image.ts', 'ops-messenger', `--tag=${tag}`],
        { timeout: 300_000 },
      );
      fixture.tags.push(tag);
      const image = await fixture.digest(tag);
      writeFileSync(
        join(fixture.directory, 'deployment.json'),
        JSON.stringify({
          name: 'messenger',
          images: { 'ops-messenger': image },
        }),
      );
      await fixture.ops('prepare');
      await fixture.ops('start');
      const broker = `import {connect} from 'amqplib'; import {messagingOptions} from './app/configs/environment'; const config=messagingOptions(); const c=await connect(config.broker); const ch=await c.createConfirmChannel();`;
      await fixture.compose([
        'exec',
        '-T',
        'app-ops-messenger',
        'bun',
        '-e',
        `${broker} ch.sendToQueue(config.queue, Buffer.from('invalid-json'), {persistent:true,messageId:'retained-id',correlationId:'retained-correlation'}); await ch.waitForConfirms(); await c.close();`,
      ]);
      const retained = () =>
        fixture.compose([
          'exec',
          '-T',
          'app-ops-messenger',
          'bun',
          '-e',
          `${broker} console.log((await ch.checkQueue(config.queue+'.failed')).messageCount); await c.close();`,
        ]);
      await until(async () => (await retained()) === '1');
      for (const action of ['inspect', 'replay']) {
        const result = await fixture.opsResult(action, 'ops-messenger');
        expect(result.code).not.toBe(0);
        expect(result.stderr).toContain('no owned failure-queue interface');
      }
      expect(await retained()).toBe('1');
    }, [workspace.cleanup]);
  }, [fixture.cleanup]);
}, 300_000);

test('operators plan desired changes while inspecting and shutting down the applied installation', async () => {
  const fixture = await operationsFixture();
  const sibling = join(fixture.directory, 'sibling');
  const siblingOps = (action: string, ...args: string[]) =>
    fixture.execute(
      ['bun', 'run', 'ops', `--directory=${sibling}`, action, ...args],
      150_000,
    );
  await withCleanup(async () => {
    const deploymentPath = join(fixture.directory, 'deployment.json');
    const statePath = join(fixture.directory, 'state.json');
    const composePath = join(fixture.directory, 'compose.json');
    const bootstrap = readFileSync(deploymentPath, 'utf8');
    const sql = (app: string, query: string) =>
      fixture.compose([
        'exec',
        '-T',
        `postgres-${app}`,
        'psql',
        '-U',
        'postgres',
        '-d',
        app,
        '-At',
        '-c',
        query,
      ]);
    const plan = async () =>
      JSON.parse(await fixture.ops('plan')) as DeploymentPlan;
    await fixture.ops('prepare');
    const prepared = fixture.state();
    // Installations prepared before this state model keep their identities.
    const legacy = JSON.stringify({
      version: 1,
      project: prepared.project,
      owner: prepared.owner,
      directory: prepared.directory,
      config: JSON.parse(bootstrap) as unknown,
      artifacts: prepared.applied.applications,
    });
    writeFileSync(statePath, legacy);
    const legacyPlan = await fixture.opsResult('plan');
    expect(legacyPlan.code, legacyPlan.stderr).toBe(0);
    expect(legacyPlan.stderr).toContain('adopted in memory');
    expect(readFileSync(statePath, 'utf8')).toBe(legacy);
    const pending = (JSON.parse(legacyPlan.stdout) as DeploymentPlan)
      .migrations;
    expect(
      pending.map(({ application, history }) => [application, history]),
    ).toEqual([
      ['user', 'read'],
      ['wallet', 'read'],
    ]);
    const adoption = await fixture.opsResult('migrate', 'user');
    expect(adoption.code, adoption.stderr).toBe(0);
    expect(adoption.stderr).toContain('Recorded the existing inventory');
    expect(fixture.state()).toMatchObject({
      version: 2,
      project: prepared.project,
      owner: prepared.owner,
      retained: prepared.retained,
    });
    const adoptedInventory = readFileSync(statePath, 'utf8');
    await sql('user', 'ALTER ROLE user_owner NOLOGIN');
    await withCleanup(async () => {
      expect((await plan()).migrations).toContainEqual({
        application: 'user',
        image: fixture.images.user,
        history: 'unavailable',
        applicable: null,
        unknownToImage: null,
      });
      expect(readFileSync(statePath, 'utf8')).toBe(adoptedInventory);
    }, [() => sql('user', 'ALTER ROLE user_owner LOGIN')]);
    await fixture.ops('migrate', 'wallet');
    for (const { application, applicable } of pending)
      expect(applicable).toEqual(
        (
          await sql(application, 'SELECT name FROM pgmigrations ORDER BY id')
        ).split('\n'),
      );
    await fixture.ops('start');
    const profile = {
      email: 'planning@example.com',
      country: 'England',
      street: 'Baker street',
      postalCode: 'NW16XE',
    };
    await fixture.request('/v1/users', { method: 'POST', data: profile });
    const users = await fixture.request('/v1/users');
    const userId = z
      .object({ data: z.array(z.object({ id: z.string() })) })
      .parse(users).data[0].id;
    await until(async () =>
      fixture.request(`/v1/wallets/by-user/${userId}`).then(
        () => true,
        () => false,
      ),
    );
    const wallet = await fixture.request(`/v1/wallets/by-user/${userId}`);

    // A sibling installation shares the host but none of its resources.
    mkdirSync(join(sibling, 'secrets'), { recursive: true, mode: 0o700 });
    for (const file of [
      'wallet-admin-password',
      'wallet-owner-password',
      'wallet-runtime-password',
      'broker-password',
    ])
      writeFileSync(join(sibling, 'secrets', file), `${randomUUID()}\n`, {
        mode: 0o444,
      });
    for (const file of ['tls.crt', 'tls.key'])
      writeFileSync(
        join(sibling, 'secrets', file),
        readFileSync(join(fixture.directory, 'secrets', file)),
        { mode: 0o444 },
      );
    writeFileSync(
      join(sibling, 'deployment.json'),
      JSON.stringify({
        name: 'sibling',
        images: { wallet: fixture.images.wallet },
        https: { bind: '127.0.0.1', port: await availablePort() },
      }),
    );
    await siblingOps('prepare');
    await siblingOps('migrate', 'wallet');
    const siblingProject = stateSchema.parse(
      JSON.parse(readFileSync(join(sibling, 'state.json'), 'utf8')),
    ).project;
    const siblingContainers = () =>
      fixture.execute([
        'docker',
        'ps',
        '-q',
        '--filter',
        `label=com.docker.compose.project=${siblingProject}`,
      ]);
    const siblingBefore = await siblingContainers();
    expect(siblingBefore).not.toBe('');

    const project = fixture.state().project;
    const identity = async () => {
      const { owner, retained } = fixture.state();
      const volumes = (
        await fixture.execute([
          'docker',
          'volume',
          'ls',
          '-q',
          '--filter',
          `label=com.docker.compose.project=${project}`,
        ])
      ).split('\n');
      return {
        owner,
        retained,
        volumes: await fixture.execute([
          'docker',
          'volume',
          'inspect',
          '--format',
          '{{.Name}} {{.CreatedAt}}',
          ...volumes,
        ]),
        roles: [
          await sql(
            'user',
            "SELECT string_agg(oid || ':' || rolname, ',' ORDER BY rolname) FROM pg_roles WHERE rolname LIKE 'user\\_%'",
          ),
          await sql(
            'wallet',
            "SELECT string_agg(oid || ':' || rolname, ',' ORDER BY rolname) FROM pg_roles WHERE rolname LIKE 'wallet\\_%'",
          ),
        ],
      };
    };
    const durable = async () => [
      await sql('user', 'SELECT row_to_json(users) FROM users ORDER BY id'),
      await sql(
        'wallet',
        'SELECT row_to_json(wallets) FROM wallets ORDER BY id',
      ),
      await sql('user', 'SELECT name FROM pgmigrations ORDER BY id'),
    ];
    const identityBefore = await identity();
    const dataBefore = await durable();

    const compatible = await fixture.variant('compatible');
    const ledger = await fixture.variant('addition');
    const desired = {
      ...(JSON.parse(bootstrap) as object),
      images: { user: compatible, ledger },
    };
    writeFileSync(deploymentPath, JSON.stringify(desired));
    const inventory = () => [
      readFileSync(statePath, 'utf8'),
      readFileSync(composePath, 'utf8'),
      readFileSync(deploymentPath, 'utf8'),
    ];
    const inventoryBefore = inventory();
    const containersBefore = await fixture.compose(['ps', '-q']);
    const preview = await plan();
    expect(preview.installation).toEqual({
      name: 'verification',
      project,
      status: 'existing',
    });
    expect(
      preview.applied.applications.map(
        ({ application, image, migration, startup }) => [
          application,
          image,
          typeof migration === 'string' ? migration : migration.result,
          typeof startup === 'string'
            ? startup
            : `${startup.result}:${startup.readiness}`,
        ],
      ),
    ).toEqual([
      ['user', fixture.images.user, 'committed', 'verified:http'],
      ['wallet', fixture.images.wallet, 'committed', 'verified:http'],
    ]);
    expect(preview.changes).toEqual({
      additions: [
        {
          application: 'ledger',
          image: ledger,
          persistence: true,
          messaging: true,
          exposure: false,
          routes: [],
        },
      ],
      removals: [{ application: 'wallet', image: fixture.images.wallet }],
      images: [
        { application: 'user', from: fixture.images.user, to: compatible },
      ],
      capabilities: [],
      ingress: null,
    });
    expect(preview.services).toEqual({
      add: ['app-ledger', 'postgres-ledger'],
      stop: ['app-wallet', 'postgres-wallet'],
      recreate: ['app-user', 'gateway'],
      unchanged: ['postgres-user', 'rabbitmq'],
    });
    expect(preview.resources.retain).toEqual([
      {
        kind: 'database',
        application: 'user',
        volume: `${project}_postgres-user`,
        before: 'active',
        after: 'active',
      },
      {
        kind: 'database',
        application: 'wallet',
        volume: `${project}_postgres-wallet`,
        before: 'active',
        after: 'inactive',
      },
      {
        kind: 'broker',
        volume: `${project}_rabbitmq`,
        before: 'active',
        after: 'active',
      },
    ]);
    expect(preview.resources.provision).toEqual([
      {
        kind: 'database',
        application: 'ledger',
        volume: `${project}_postgres-ledger`,
        database: 'ledger',
        roles: ['ledger_owner', 'ledger_runtime'],
        secrets: [
          'ledger-admin-password',
          'ledger-owner-password',
          'ledger-runtime-password',
        ],
      },
    ]);
    expect(preview.resources.missingSecrets).toEqual([
      'ledger-admin-password',
      'ledger-owner-password',
      'ledger-runtime-password',
    ]);
    expect(preview.migrations).toEqual([
      {
        application: 'ledger',
        image: ledger,
        history: 'new-database',
        applicable: (
          await sql('wallet', 'SELECT name FROM pgmigrations ORDER BY id')
        ).split('\n'),
        unknownToImage: [],
      },
      {
        application: 'user',
        image: compatible,
        history: 'read',
        applicable: ['1990000000000_operations-compatible'],
        unknownToImage: [],
      },
    ]);
    expect(preview.interruptions.map(({ service }) => service)).toEqual([
      'app-user',
      'app-wallet',
      'gateway',
      'postgres-wallet',
    ]);
    // Planning and ordinary preparation leave the applied installation unchanged.
    expect(inventory()).toEqual(inventoryBefore);
    expect(await fixture.compose(['ps', '-q'])).toBe(containersBefore);
    expect(await durable()).toEqual(dataBefore);
    expect(await fixture.ops('prepare')).toContain(
      'Preparation does not apply topology changes',
    );
    expect(fixture.state()).toEqual(
      stateSchema.parse(JSON.parse(inventoryBefore[0])),
    );
    expect(readFileSync(composePath, 'utf8')).toBe(inventoryBefore[1]);
    expect(await fixture.compose(['ps', '-q'])).toBe(containersBefore);
    expect(await identity()).toEqual(identityBefore);

    // The desired removal does not strand inspection of the applied application.
    expect(await fixture.ops('probe', 'wallet')).toContain('"readiness"');
    expect(await fixture.ops('status', 'wallet')).toContain('applied\t');

    const incompatible = await fixture.variant('incompatible');
    writeFileSync(
      deploymentPath,
      JSON.stringify({
        ...desired,
        images: { user: incompatible, billing: fixture.images.wallet },
      }),
    );
    const rejected = await fixture.opsResult('plan');
    expect(rejected.code).not.toBe(0);
    expect(rejected.stderr).toContain(
      'user: Image preflight failed for user: Application user: group user-profile requires persistence',
    );
    expect(rejected.stderr).toContain(
      'billing: Image does not own the selected application; it declares wallet',
    );
    // Desired edits never bypass ownership guards.
    writeFileSync(deploymentPath, JSON.stringify(desired));
    const foreign = { name: `${project}-foreign`, owner: randomUUID() };
    await withCleanup(async () => {
      await fixture.execute([
        'docker',
        'create',
        '--name',
        foreign.name,
        '--label',
        `com.docker.compose.project=${project}`,
        '--label',
        `dev.starter.owner=${foreign.owner}`,
        'registry:2',
      ]);
      for (const action of ['plan', 'down']) {
        const refused = await fixture.opsResult(action);
        expect(refused.code).not.toBe(0);
        expect(refused.stderr).toContain(
          'Refusing resource owned by another environment',
        );
      }
    }, [() => removeOwnedContainer(foreign)]);
    expect(await fixture.compose(['ps', '-q'])).toBe(containersBefore);

    // An invalid desired selection does not strand inspection or shutdown.
    writeFileSync(
      deploymentPath,
      JSON.stringify({ name: 'verification', images: { user: 'user:latest' } }),
    );
    for (const args of [
      ['plan'],
      ['update', 'user', `--image=${compatible}`],
    ]) {
      const invalid = await fixture.opsResult(
        ...(args as [string, ...string[]]),
      );
      expect(invalid.code).not.toBe(0);
      expect(invalid.stderr).toContain('exact repository@sha256 image digest');
    }
    expect(await fixture.ops('probe', 'user')).toContain('"readiness"');
    expect(await fixture.ops('status', 'user')).toContain('applied\t');
    expect(await fixture.ops('inspect', 'wallet')).toContain('"messages"');
    expect(inventory().slice(0, 2)).toEqual(inventoryBefore.slice(0, 2));
    expect(await fixture.compose(['ps', '-q'])).toBe(containersBefore);

    await fixture.ops('down');
    expect(await fixture.compose(['ps', '-aq'])).toBe('');
    expect(await siblingContainers()).toBe(siblingBefore);
    expect(await siblingOps('status', 'wallet')).toContain('applied\t');
    writeFileSync(deploymentPath, JSON.stringify(desired));
    await fixture.ops('prepare');
    await fixture.ops('start');
    expect(await identity()).toEqual(identityBefore);
    expect(await durable()).toEqual(dataBefore);
    expect(await fixture.request('/v1/users')).toEqual(users);
    expect(await fixture.request(`/v1/wallets/by-user/${userId}`)).toEqual(
      wallet,
    );

    // Updating the requested image keeps the remaining desired edits pending.
    await fixture.ops('update', 'user', `--image=${compatible}`);
    expect(JSON.parse(readFileSync(deploymentPath, 'utf8'))).toEqual(desired);
    const updated = await plan();
    expect(updated.changes.images).toEqual([]);
    expect(
      updated.changes.additions.map(({ application }) => application),
    ).toEqual(['ledger']);
    expect(
      updated.changes.removals.map(({ application }) => application),
    ).toEqual(['wallet']);
    expect(updated.applied.applications[0]).toMatchObject({
      application: 'user',
      image: compatible,
      migration: {
        operation: 'update',
        image: compatible,
        result: 'committed',
      },
      startup: {
        operation: 'update',
        image: compatible,
        readiness: 'full',
        result: 'verified',
      },
    });
    expect(await siblingContainers()).toBe(siblingBefore);
  }, [
    async () => {
      if (existsSync(join(sibling, 'state.json'))) await siblingOps('down');
    },
    fixture.cleanup,
  ]);
}, 600_000);

/** Select, review and apply desired selections through the public operator commands. */
function topology(fixture: Awaited<ReturnType<typeof operationsFixture>>) {
  const deploymentPath = join(fixture.directory, 'deployment.json');
  const bootstrap = JSON.parse(readFileSync(deploymentPath, 'utf8')) as {
    images: Record<string, string>;
  };
  const reviewed = join(fixture.directory, 'plan.json');
  return {
    deploymentPath,
    reviewed,
    select: (images: Record<string, string>) => {
      writeFileSync(deploymentPath, JSON.stringify({ ...bootstrap, images }));
    },
    /** Save the preview as the reviewed plan, then apply exactly that file. */
    review: async () => {
      const output = await fixture.ops('plan');
      writeFileSync(reviewed, output);
      return {
        preview: JSON.parse(output) as DeploymentPlan,
        result: await fixture.opsResult('apply', `--plan=${reviewed}`),
      };
    },
    sql: (app: string, query: string) =>
      fixture.compose([
        'exec',
        '-T',
        `postgres-${app}`,
        'psql',
        '-U',
        'postgres',
        '-d',
        app,
        '-At',
        '-v',
        'ON_ERROR_STOP=1',
        '-c',
        query,
      ]),
  };
}

test('apply restarts retained databases after shutdown and recovers a failed gateway reload', async () => {
  const fixture = await operationsFixture();
  await withCleanup(async () => {
    const { deploymentPath, select, review, sql } = topology(fixture);
    await fixture.ops('prepare');
    await fixture.ops('migrate', 'user');
    await fixture.ops('migrate', 'wallet');
    await fixture.ops('start');
    const compatible = await fixture.variant('compatible');
    const retained = fixture.state().retained;
    await fixture.ops('down');
    select({ user: compatible, wallet: fixture.images.wallet });
    const restarted = await review();
    expect(
      restarted.preview.migrations.every(
        ({ history }) => history === 'unavailable',
      ),
    ).toBe(true);
    expect(restarted.result.code, restarted.result.stderr).toBe(0);
    expect(fixture.state().retained).toEqual(retained);
    expect(await sql('user', 'SELECT count(*) FROM operations_marker')).toBe(
      '0',
    );

    // A stopped existing database must also be started before rejecting an older image.
    await fixture.compose(['stop', 'postgres-user']);
    select(fixture.images);
    const older = await review();
    expect(older.result.code).not.toBe(0);
    expect(older.result.stderr).toContain(
      'its database already applied migrations unknown to the selected image',
    );
    expect(await sql('user', 'SELECT count(*) FROM operations_marker')).toBe(
      '0',
    );

    // Both supported recovery commands must retain a pending gateway reload.
    for (const recovery of ['continue', 'apply']) {
      // Removal and listener selection complete before a real bind failure in Kong.
      const port = await availablePort();
      const occupied = {
        name: `ddh-gateway-conflict-${randomUUID()}`,
        owner: randomUUID(),
      };
      await withCleanup(async () => {
        await fixture.execute([
          'docker',
          'run',
          '-d',
          '--name',
          occupied.name,
          '--label',
          `dev.starter.owner=${occupied.owner}`,
          '-p',
          `127.0.0.1:${String(port)}:5000`,
          'registry:2',
        ]);
        select({ user: compatible });
        const desired = JSON.parse(
          readFileSync(deploymentPath, 'utf8'),
        ) as Record<string, unknown>;
        writeFileSync(
          deploymentPath,
          JSON.stringify({ ...desired, https: { bind: '127.0.0.1', port } }),
        );
        const blocked = await review();
        expect(blocked.result.code).not.toBe(0);
        expect(blocked.result.stderr).toContain('- ingress: completed');
        if (recovery === 'continue')
          expect(blocked.result.stderr).toContain('- remove wallet: completed');
        expect(blocked.result.stderr).toContain('- reconcile: failed');
      }, [() => removeOwnedContainer(occupied)]);
      if (recovery === 'continue') await fixture.ops('continue');
      else {
        const replacement = await review();
        expect(replacement.preview.services.recreate).toEqual(['gateway']);
        expect(
          replacement.preview.interruptions.map(({ service }) => service),
        ).toEqual(['gateway']);
        expect(replacement.result.code, replacement.result.stderr).toBe(0);
      }
      expect(fixture.state().pendingDeployment).toBeUndefined();
      const status = (path: string) =>
        fixture.execute([
          'curl',
          '--silent',
          '--show-error',
          '--cacert',
          join(fixture.directory, 'secrets', 'tls.crt'),
          '--output',
          '/dev/null',
          '--write-out',
          '%{http_code}',
          `https://127.0.0.1:${String(port)}${path}`,
        ]);
      await until(async () => (await status('/v1/users')) === '200');
      expect(await status('/v1/wallets/by-user/removed')).toBe('404');
    }
  }, [fixture.cleanup]);
}, 300_000);

test('operators apply reviewed topology changes and reactivate retained resources with their identities, data and accepted work', async () => {
  const fixture = await operationsFixture();
  const sibling = join(fixture.directory, 'sibling');
  const siblingOps = (action: string, ...args: string[]) =>
    fixture.execute(
      ['bun', 'run', 'ops', `--directory=${sibling}`, action, ...args],
      150_000,
    );
  await withCleanup(async () => {
    const { select, review, reviewed, sql } = topology(fixture);
    const planAndApply = async () => {
      const { preview, result } = await review();
      expect(result.code, result.stderr).toBe(0);
      expect(fixture.state().pendingDeployment).toBeUndefined();
      return { preview, applied: result.stdout };
    };
    const owned = (filter: string[], format = '{{.ID}}') =>
      fixture.execute([
        'docker',
        'ps',
        '-a',
        '--filter',
        `label=com.docker.compose.project=${fixture.state().project}`,
        ...filter,
        '--format',
        format,
      ]);
    const container = (service: string) =>
      owned(['--filter', `label=com.docker.compose.service=${service}`]);
    const queue = async () =>
      z
        .array(
          z.object({
            name: z.string(),
            messages: z.number(),
            consumers: z.number(),
          }),
        )
        .parse(
          JSON.parse(
            await fixture.compose([
              'exec',
              '-T',
              'rabbitmq',
              'rabbitmqctl',
              'list_queues',
              '--quiet',
              '-p',
              fixture.state().project,
              'name',
              'messages',
              'consumers',
              '--formatter',
              'json',
            ]),
          ),
        )
        .find(({ name }) => name === 'wallet.user-created');
    const createUser = async (email: string) => {
      await fixture.request('/v1/users', {
        method: 'POST',
        data: {
          email,
          country: 'England',
          street: 'Baker street',
          postalCode: 'NW16XE',
        },
      });
      const id = z
        .object({
          data: z.array(z.object({ id: z.string(), email: z.string() })),
        })
        .parse(await fixture.request('/v1/users'))
        .data.find((user) => user.email === email)?.id;
      if (!id) throw new Error(`User ${email} was not created`);
      await until(
        async () =>
          (await sql(
            'user',
            'SELECT count(*) FROM user_outbox WHERE published_at IS NULL',
          )) === '0',
      );
      return {
        id,
        event: await sql(
          'user',
          `SELECT event_id FROM user_outbox WHERE envelope->'data'->>'userId' = '${id}'`,
        ),
      };
    };
    const consumed = (event: string) =>
      sql(
        'wallet',
        `SELECT user_id FROM wallet_consumed_events WHERE event_id = '${event}'`,
      );
    const secrets = (app: string) =>
      ['admin', 'owner', 'runtime'].map((role) =>
        readFileSync(
          join(fixture.directory, 'secrets', `${app}-${role}-password`),
          'utf8',
        ),
      );
    const roles = (app: string) =>
      sql(
        app,
        `SELECT string_agg(oid || ':' || rolname, ',' ORDER BY rolname) FROM pg_roles WHERE rolname LIKE '${app}\\_%'`,
      );
    const volumes = async () => {
      const ids = (
        await fixture.execute([
          'docker',
          'volume',
          'ls',
          '-q',
          '--filter',
          `label=com.docker.compose.project=${fixture.state().project}`,
        ])
      ).split('\n');
      return fixture.execute([
        'docker',
        'volume',
        'inspect',
        '--format',
        '{{.Name}} {{.CreatedAt}}',
        ...ids,
      ]);
    };

    // plan -> apply: the explicit operator action bootstraps User alone.
    select({ user: fixture.images.user });
    const bootstrapped = await planAndApply();
    expect(bootstrapped.preview.installation.status).toBe('new');
    expect(bootstrapped.preview.services.add).toEqual([
      'app-user',
      'gateway',
      'postgres-user',
      'rabbitmq',
    ]);
    const project = fixture.state().project;
    expect(fixture.state().applied.applications).toMatchObject([
      {
        image: fixture.images.user,
        migration: { operation: 'apply', result: 'committed' },
        startup: { operation: 'apply', readiness: 'full', result: 'verified' },
      },
    ]);
    expect(
      await container('app-user').then((id) =>
        fixture.execute([
          'docker',
          'inspect',
          '--format',
          '{{json .HostConfig.PortBindings}}',
          id,
        ]),
      ),
    ).toBe('{}');
    // A producer accepts durable work before its consumer was ever applied.
    const first = await createUser('first-apply@example.com');
    expect(await queue()).toEqual({
      name: 'wallet.user-created',
      messages: 1,
      consumers: 0,
    });

    // Sibling installations share the host but none of the resources.
    mkdirSync(join(sibling, 'secrets'), { recursive: true, mode: 0o700 });
    for (const file of [
      'wallet-admin-password',
      'wallet-owner-password',
      'wallet-runtime-password',
      'broker-password',
    ])
      writeFileSync(join(sibling, 'secrets', file), `${randomUUID()}\n`, {
        mode: 0o444,
      });
    for (const file of ['tls.crt', 'tls.key'])
      writeFileSync(
        join(sibling, 'secrets', file),
        readFileSync(join(fixture.directory, 'secrets', file)),
        { mode: 0o444 },
      );
    writeFileSync(
      join(sibling, 'deployment.json'),
      JSON.stringify({
        name: 'sibling',
        images: { wallet: fixture.images.wallet },
        https: { bind: '127.0.0.1', port: await availablePort() },
      }),
    );
    await siblingOps('prepare');
    await siblingOps('migrate', 'wallet');
    const siblingProject = stateSchema.parse(
      JSON.parse(readFileSync(join(sibling, 'state.json'), 'utf8')),
    ).project;
    const siblingContainers = () =>
      fixture.execute([
        'docker',
        'ps',
        '-q',
        '--filter',
        `label=com.docker.compose.project=${siblingProject}`,
      ]);
    const siblingBefore = await siblingContainers();
    expect(siblingBefore).not.toBe('');

    // add: Wallet joins without promoting, re-provisioning or resetting User.
    const userContainer = await container('app-user');
    const userRoles = await roles('user');
    const userSecrets = secrets('user');
    const userRows = () =>
      sql('user', 'SELECT row_to_json(users) FROM users ORDER BY id');
    const usersBefore = await userRows();
    select({ user: fixture.images.user, wallet: fixture.images.wallet });
    expect(await fixture.ops('prepare')).toContain(
      'Preparation does not apply topology changes',
    );
    expect(await container('app-wallet')).toBe('');
    const added = await planAndApply();
    expect(added.preview.services).toEqual({
      add: ['app-wallet', 'postgres-wallet'],
      stop: [],
      recreate: ['gateway'],
      unchanged: ['app-user', 'postgres-user', 'rabbitmq'],
    });
    expect(added.preview.resources.provision).toMatchObject([
      { kind: 'database', application: 'wallet' },
    ]);
    expect(await container('app-user')).toBe(userContainer);
    expect(await roles('user')).toBe(userRoles);
    expect(secrets('user')).toEqual(userSecrets);
    expect(await userRows()).toBe(usersBefore);
    expect(
      await fixture.compose(['exec', '-T', 'app-wallet', 'ls', '/run/secrets']),
    ).toBe('broker-password\nwallet-runtime-password');
    await until(async () => (await consumed(first.event)) === first.id);
    const firstWallet = await fixture.request(
      `/v1/wallets/by-user/${first.id}`,
    );
    expect(firstWallet).toMatchObject({ userId: first.id });

    // disable: withdrawing Wallet's exposure removes its routes, not its work.
    // Its owned migration makes the retained database newer than the original image.
    const privateMigration = {
      '/app/app/database/migrations/1990000000020_operations-private.sql':
        '-- Up Migration\nCREATE TABLE operations_private (id integer);\n-- Down Migration\nDROP TABLE operations_private;\n',
    };
    const privateWallet = await fixture.derive(
      'wallet',
      fixture.images.wallet,
      'private',
      {
        '/app/app/application.json': JSON.stringify({
          name: 'wallet',
          persistence: true,
          messaging: true,
          exposure: false,
        }),
        ...privateMigration,
      },
    );
    select({ user: fixture.images.user, wallet: privateWallet });
    const disabled = await planAndApply();
    expect(disabled.preview.changes.capabilities).toEqual([
      {
        application: 'wallet',
        from: {
          persistence: true,
          messaging: true,
          exposure: true,
          routes: [
            {
              name: 'rest',
              paths: ['~/v1/wallets/by-user/[^/]+$'],
              methods: ['GET'],
              stripPath: false,
            },
            {
              name: 'graphql',
              paths: ['~/wallet/graphql/?$'],
              stripPath: true,
              upstreamPath: '/graphql',
            },
          ],
        },
        to: {
          persistence: true,
          messaging: true,
          exposure: false,
          routes: [],
        },
      },
    ]);
    expect(await container('app-user')).toBe(userContainer);
    expect(
      await fixture
        .request(`/v1/wallets/by-user/${first.id}`)
        .then(() => 'routed', String),
    ).toContain('404');
    const second = await createUser('second-apply@example.com');
    await until(async () => (await consumed(second.event)) === second.id);
    const walletRoles = await roles('wallet');
    const walletSecrets = secrets('wallet');
    const walletRows = () =>
      sql('wallet', 'SELECT row_to_json(wallets) FROM wallets ORDER BY id');
    const walletsBefore = await walletRows();

    // remove: Wallet stops while its database, credentials and queue remain.
    select({ user: fixture.images.user });
    const identitiesBefore = await volumes();
    const removed = await planAndApply();
    expect(removed.preview.services.stop).toEqual([
      'app-wallet',
      'postgres-wallet',
    ]);
    expect(await container('app-wallet')).toBe('');
    expect(await container('postgres-wallet')).toBe('');
    expect(await container('app-user')).toBe(userContainer);
    expect(await volumes()).toBe(identitiesBefore);
    expect(
      fixture.state().retained.databases.map(({ application }) => application),
    ).toEqual(['user', 'wallet']);
    const inventory = z
      .object({
        databases: z.array(
          z.object({
            application: z.string(),
            activity: z.string(),
            container: z.string(),
            volumePresent: z.boolean(),
          }),
        ),
        broker: z.object({ activity: z.string(), container: z.string() }),
      })
      .parse(JSON.parse(await fixture.ops('retained')));
    expect(
      inventory.databases.map(
        ({ application, activity, container, volumePresent }) => [
          application,
          activity,
          container,
          volumePresent,
        ],
      ),
    ).toEqual([
      ['user', 'active', 'running', true],
      ['wallet', 'inactive', 'absent', true],
    ]);
    expect(inventory.broker).toMatchObject({
      activity: 'active',
      container: 'running',
    });
    // Producers keep accepting work; consumer absence never purges it.
    const third = await createUser('third-apply@example.com');
    expect(await queue()).toEqual({
      name: 'wallet.user-created',
      messages: 1,
      consumers: 0,
    });

    // inspect/down: foreign resources are refused, owned ones shut down.
    const foreign = { name: `${project}-foreign`, owner: randomUUID() };
    await withCleanup(async () => {
      await fixture.execute([
        'docker',
        'create',
        '--name',
        foreign.name,
        '--label',
        `com.docker.compose.project=${project}`,
        '--label',
        `dev.starter.owner=${foreign.owner}`,
        'registry:2',
      ]);
      select({ user: fixture.images.user, wallet: fixture.images.wallet });
      for (const args of [
        ['plan'],
        ['apply', `--plan=${reviewed}`],
        ['down'],
      ]) {
        const refused = await fixture.opsResult(
          ...(args as [string, ...string[]]),
        );
        expect(refused.code).not.toBe(0);
        expect(refused.stderr).toContain(
          'Refusing resource owned by another environment',
        );
      }
    }, [() => removeOwnedContainer(foreign)]);
    expect(await container('app-user')).toBe(userContainer);
    await fixture.ops('down');
    expect(await owned([])).toBe('');
    expect(await volumes()).toBe(identitiesBefore);
    expect(await siblingContainers()).toBe(siblingBefore);
    await fixture.ops('prepare');
    await fixture.ops('start');
    expect(await queue()).toEqual({
      name: 'wallet.user-created',
      messages: 1,
      consumers: 0,
    });

    // An image older than the retained database is refused once its history is
    // readable, without restoring Wallet or changing its data.
    // The retained database container is absent from the applied Compose file.
    const walletHistory = async () =>
      fixture.execute([
        'docker',
        'exec',
        await container('postgres-wallet'),
        'psql',
        '-U',
        'postgres',
        '-d',
        'wallet',
        '-At',
        '-c',
        'SELECT name FROM pgmigrations ORDER BY id',
      ]);
    select({ user: fixture.images.user, wallet: fixture.images.wallet });
    const older = await review();
    expect(
      older.preview.migrations.find(
        ({ application }) => application === 'wallet',
      )?.history,
    ).toBe('unavailable');
    expect(older.result.code).not.toBe(0);
    expect(older.result.stderr).toContain(
      'wallet: its database already applied migrations unknown to the selected image (1990000000020_operations-private)',
    );
    expect(older.result.stderr).toContain('- promote wallet: failed');
    expect(await container('app-wallet')).toBe('');
    expect(await walletHistory()).toContain('1990000000020_operations-private');
    expect(await queue()).toMatchObject({ messages: 1, consumers: 0 });

    // reactivate: a reviewed compatible image supersedes the refused deployment,
    // reuses Wallet's identities and recovers retained work.
    const exposedWallet = await fixture.derive(
      'wallet',
      privateWallet,
      'exposed',
      {
        '/app/app/application.json': readFileSync(
          'src/apps/wallet/application.json',
          'utf8',
        ),
      },
    );
    const historyBefore = await walletHistory();
    select({ user: fixture.images.user, wallet: exposedWallet });
    const reactivated = await planAndApply();
    expect(await walletHistory()).toBe(historyBefore);
    expect(reactivated.preview.resources.provision).toEqual([]);
    expect(reactivated.preview.resources.retain).toContainEqual({
      kind: 'database',
      application: 'wallet',
      volume: `${project}_postgres-wallet`,
      before: 'inactive',
      after: 'active',
    });
    await until(async () => (await consumed(third.event)) === third.id);
    // Acknowledgement follows the committed consumption.
    await until(async () => (await queue())?.messages === 0);
    expect(await queue()).toMatchObject({ consumers: 1 });
    expect(
      await fixture.request(`/v1/wallets/by-user/${third.id}`),
    ).toMatchObject({ userId: third.id });
    expect(await fixture.request(`/v1/wallets/by-user/${first.id}`)).toEqual(
      firstWallet,
    );
    expect(await roles('wallet')).toBe(walletRoles);
    expect(secrets('wallet')).toEqual(walletSecrets);
    expect(await roles('user')).toBe(userRoles);
    expect(secrets('user')).toEqual(userSecrets);
    expect(await volumes()).toBe(identitiesBefore);
    expect(
      (await walletRows())
        .split('\n')
        .filter((row) => !row.includes(third.id))
        .join('\n'),
    ).toBe(walletsBefore);
    expect(await siblingContainers()).toBe(siblingBefore);

    // Disabling every exposure retires Kong; private probes and data remain.
    const privateUser = await fixture.derive(
      'user',
      fixture.images.user,
      'private',
      {
        '/app/app/application.json': JSON.stringify({
          name: 'user',
          persistence: true,
          messaging: true,
          exposure: false,
        }),
      },
    );
    const usersAfter = await userRows();
    select({ user: privateUser, wallet: privateWallet });
    const unexposed = await planAndApply();
    expect(unexposed.preview.services.stop).toEqual(['gateway']);
    expect(await container('gateway')).toBe('');
    expect(
      await fixture.execute([
        'docker',
        'network',
        'ls',
        '-q',
        '--filter',
        `label=com.docker.compose.project=${project}`,
        '--filter',
        'label=com.docker.compose.network=ingress',
      ]),
    ).toBe('');
    expect(
      await fixture.request('/v1/users').catch((error: unknown) => error),
    ).toBeInstanceOf(Error);
    expect(await fixture.ops('probe', 'user')).toContain('"http":"ready"');
    expect(await userRows()).toBe(usersAfter);
    expect(await volumes()).toBe(identitiesBefore);
    expect(await roles('user')).toBe(userRoles);
    console.log(`Topology evidence: ${fixture.directory}`);
  }, [
    async () => {
      if (existsSync(join(sibling, 'state.json'))) await siblingOps('down');
    },
    fixture.cleanup,
  ]);
}, 900_000);

test('a multi-application apply stops after a later failure and explicit continuation completes it without repeating migrations', async () => {
  const fixture = await operationsFixture();
  await withCleanup(async () => {
    const { deploymentPath, select, reviewed, sql, ...plans } =
      topology(fixture);
    const review = async () => (await plans.review()).result;
    const history = (app: string) =>
      sql(app, 'SELECT name FROM pgmigrations ORDER BY id');
    const container = (service: string) =>
      fixture.compose(['ps', '-q', service]);
    const applied = (app: string) =>
      fixture
        .state()
        .applied.applications.find((entry) => entry.declaration.name === app);
    const record = () =>
      z
        .object({
          status: z.string(),
          steps: z.array(
            z.object({
              kind: z.string(),
              application: z.string().nullable(),
              status: z.string(),
            }),
          ),
          attempts: z.array(
            z.object({ operation: z.string(), outcome: z.string() }),
          ),
        })
        .parse(
          JSON.parse(
            readFileSync(
              join(
                fixture.directory,
                `apply-${fixture.state().pendingDeployment ?? 'missing'}.json`,
              ),
              'utf8',
            ),
          ),
        );
    const progress = () =>
      record().steps.map(({ kind, application, status }) =>
        [kind, application ?? '', status].join(':'),
      );
    const backups = () =>
      existsSync(join(fixture.directory, 'backups'))
        ? readdirSync(join(fixture.directory, 'backups')).filter((file) =>
            file.endsWith('.dump'),
          )
        : [];
    const migration = (name: string, sql: string) => ({
      [`/app/app/database/migrations/${name}.sql`]: `-- Up Migration\n${sql}\n-- Down Migration\nSELECT 1;\n`,
    });

    const bootstrapped = await review();
    expect(bootstrapped.code, bootstrapped.stderr).toBe(0);
    const profile = {
      email: 'continuation@example.com',
      country: 'England',
      street: 'Baker street',
      postalCode: 'NW16XE',
    };
    await fixture.request('/v1/users', { method: 'POST', data: profile });
    const users = await fixture.request('/v1/users');
    const userId = z
      .object({ data: z.array(z.object({ id: z.string() })) })
      .parse(users).data[0].id;
    await until(async () =>
      fixture.request(`/v1/wallets/by-user/${userId}`).then(
        () => true,
        () => false,
      ),
    );
    const wallet = await fixture.request(`/v1/wallets/by-user/${userId}`);

    // A later migration fails: User's completed promotion is retained.
    const compatibleUser = await fixture.variant('compatible');
    const gatedWallet = await fixture.derive(
      'wallet',
      fixture.images.wallet,
      'gated',
      migration(
        '1990000000010_operations-gated',
        'CREATE TABLE operations_gated (id integer);\nSELECT 1 / (SELECT count(*) FROM operations_release)::integer;',
      ),
    );
    select({ user: compatibleUser, wallet: gatedWallet });
    const walletHistory = await history('wallet');
    const gated = await review();
    expect(gated.code).not.toBe(0);
    const evidence = /Diagnostic: (.+\/run.log)/.exec(gated.stderr)?.[1];
    expect(readFileSync(evidence ?? 'missing', 'utf8')).toContain(
      'operations_release',
    );
    expect(gated.stderr).toContain('Topology deployment incomplete');
    expect(gated.stderr).toContain('- promote user: completed');
    expect(gated.stderr).toContain('- promote wallet: failed');
    expect(progress()).toEqual([
      'promote:user:completed',
      'promote:wallet:failed',
      'reconcile::not-started',
    ]);
    expect(applied('user')).toMatchObject({
      image: compatibleUser,
      migration: { operation: 'apply', image: compatibleUser },
      startup: {
        operation: 'apply',
        image: compatibleUser,
        result: 'verified',
      },
    });
    expect(applied('wallet')).toMatchObject({
      image: fixture.images.wallet,
      migration: { operation: 'apply', image: gatedWallet, result: 'failed' },
    });
    // No partial schema, automatic reversal or desired-selection rewrite.
    expect(await history('wallet')).toBe(walletHistory);
    expect(
      await sql(
        'wallet',
        "SELECT count(*) FROM pg_tables WHERE tablename = 'operations_gated'",
      ),
    ).toBe('0');
    expect(await history('user')).toContain(
      '1990000000000_operations-compatible',
    );
    expect(
      JSON.parse(readFileSync(deploymentPath, 'utf8')) as unknown,
    ).toMatchObject({ images: { user: compatibleUser, wallet: gatedWallet } });
    expect(await container('app-wallet')).toBe('');
    expect(await fixture.request('/v1/users')).toEqual(users);
    const blocked = await fixture.opsResult(
      'update',
      'user',
      `--image=${fixture.images.user}`,
    );
    expect(blocked.code).not.toBe(0);
    expect(blocked.stderr).toContain(
      'Continue the incomplete topology deployment',
    );

    // The operator repairs the precondition and continues explicitly.
    await sql(
      'wallet',
      'CREATE TABLE operations_release (id integer); INSERT INTO operations_release VALUES (1); GRANT SELECT ON operations_release TO wallet_owner;',
    );
    const userContainer = await container('app-user');
    const userHistory = await history('user');
    const userBackups = backups().filter((file) => file.startsWith('user-'));
    const continued = await fixture.ops('continue');
    expect(continued).toContain('- promote wallet: completed');
    expect(fixture.state().pendingDeployment).toBeUndefined();
    expect(await container('app-user')).toBe(userContainer);
    expect(await history('user')).toBe(userHistory);
    expect(backups().filter((file) => file.startsWith('user-'))).toEqual(
      userBackups,
    );
    expect(
      (await history('wallet'))
        .split('\n')
        .filter((name) => name === '1990000000010_operations-gated'),
    ).toHaveLength(1);
    expect(applied('wallet')).toMatchObject({
      image: gatedWallet,
      migration: {
        operation: 'apply',
        image: gatedWallet,
        result: 'committed',
      },
      startup: { operation: 'apply', result: 'verified' },
    });
    await until(async () =>
      fixture.request(`/v1/wallets/by-user/${userId}`).then(
        () => true,
        () => false,
      ),
    );
    expect(await fixture.request(`/v1/wallets/by-user/${userId}`)).toEqual(
      wallet,
    );

    // An earlier candidate fails verification: later promotions wait for it.
    const faultyUser = await fixture.derive(
      'user',
      compatibleUser,
      'apply-process',
      {
        '/app/app/main.ts': `import { existsSync } from 'node:fs';\nif (!existsSync('/tmp/operations-recover')) throw new Error('candidate startup fault');\n${readFileSync('src/apps/user/main.ts', 'utf8')}`,
        ...migration(
          '1990000000011_operations-faulty',
          'CREATE TABLE operations_faulty (id integer);',
        ),
      },
    );
    const nextWallet = await fixture.derive(
      'wallet',
      gatedWallet,
      'next',
      migration(
        '1990000000012_operations-next',
        'CREATE TABLE operations_next (id integer);',
      ),
    );
    select({ user: faultyUser, wallet: nextWallet });
    const walletContainer = await container('app-wallet');
    const failed = await review();
    expect(failed.code).not.toBe(0);
    expect(failed.stderr).toContain('Candidate stopped after verification');
    expect(progress()).toEqual([
      'promote:user:verification-failed',
      'promote:wallet:not-started',
      'reconcile::not-started',
    ]);
    expect(fixture.state().pendingTransitions).toHaveProperty('user');
    expect(applied('user')).toMatchObject({
      image: faultyUser,
      migration: { image: faultyUser, result: 'committed' },
      startup: { image: faultyUser, result: 'failed' },
    });
    expect(applied('wallet')?.image).toBe(gatedWallet);
    expect(await container('app-wallet')).toBe(walletContainer);
    expect(await history('wallet')).not.toContain('operations-next');
    const faultyHistory = await history('user');
    expect(faultyHistory).toContain('1990000000011_operations-faulty');
    expect(await container('app-user')).toBe('');

    const stopped = await fixture.compose(['ps', '--all', '-q', 'app-user']);
    const marker = join(fixture.directory, 'operations-recover');
    writeFileSync(marker, 'recover');
    await fixture.execute([
      'docker',
      'cp',
      marker,
      `${stopped}:/tmp/operations-recover`,
    ]);
    const recovered = await fixture.ops('continue');
    expect(recovered).toContain('- promote user: completed');
    expect(recovered).toContain('- promote wallet: completed');
    expect(fixture.state().pendingDeployment).toBeUndefined();
    expect(fixture.state().pendingTransitions).toBeUndefined();
    expect(await history('user')).toBe(faultyHistory);
    expect(await history('wallet')).toContain('1990000000012_operations-next');
    expect(await container('app-user')).toBe(stopped);
    expect(await container('app-wallet')).not.toBe(walletContainer);
    expect(await fixture.request('/v1/users')).toEqual(users);
    expect(await fixture.request(`/v1/wallets/by-user/${userId}`)).toEqual(
      wallet,
    );

    // Messaging degradation keeps the candidate's HTTP but holds later promotions.
    const degradedUser = await fixture.derive(
      'user',
      faultyUser,
      'apply-degraded',
      {
        '/app/app/main.ts': readFileSync('src/apps/user/main.ts', 'utf8'),
        ...migration(
          '1990000000013_operations-degraded',
          'CREATE TABLE operations_degraded (id integer);',
        ),
      },
    );
    const finalWallet = await fixture.derive(
      'wallet',
      nextWallet,
      'final',
      migration(
        '1990000000014_operations-final',
        'CREATE TABLE operations_final (id integer);',
      ),
    );
    select({ user: degradedUser, wallet: finalWallet });
    // Apply starts stopped dependencies. Keep the broker healthy but deny new
    // candidate connections until the operator repairs its credentials.
    const degradedHistory = await withCleanup(async () => {
      await fixture.compose([
        'exec',
        '-T',
        'rabbitmq',
        'rabbitmqctl',
        'change_password',
        'scaffold',
        'unavailable-during-apply',
      ]);
      const degraded = await review();
      expect(degraded.code).not.toBe(0);
      expect(degraded.stderr).toContain('messaging verification pending');
      expect(progress()).toEqual([
        'promote:user:verification-pending',
        'promote:wallet:not-started',
        'reconcile::not-started',
      ]);
      expect(applied('wallet')?.image).toBe(nextWallet);
      await until(() =>
        fixture.request('/v1/users').then(
          () => true,
          () => false,
        ),
      );
      expect(await fixture.request('/v1/users')).toEqual(users);
      return history('user');
    }, [
      () =>
        fixture.compose([
          'exec',
          '-T',
          'rabbitmq',
          'sh',
          '-ec',
          'rabbitmqctl change_password scaffold "$(cat /run/secrets/broker-password)"',
        ]),
    ]);
    expect(degradedHistory).toContain('1990000000013_operations-degraded');
    const resumed = await fixture.ops('continue');
    expect(resumed).toContain('- promote wallet: completed');
    expect(fixture.state().pendingDeployment).toBeUndefined();
    expect(await history('user')).toBe(degradedHistory);
    expect(await history('wallet')).toContain('1990000000014_operations-final');
    expect(applied('user')).toMatchObject({
      image: degradedUser,
      startup: { operation: 'apply', readiness: 'full', result: 'verified' },
    });
    expect(await fixture.request(`/v1/wallets/by-user/${userId}`)).toEqual(
      wallet,
    );

    // An older image is a rollback: apply refuses it without a compatibility review.
    const statePath = join(fixture.directory, 'state.json');
    const inventory = readFileSync(statePath, 'utf8');
    const serving = await container('app-user');
    select({ user: compatibleUser, wallet: finalWallet });
    const rollback = await review();
    expect(rollback.code).not.toBe(0);
    expect(rollback.stderr).toContain(
      'user: its database already applied migrations unknown to the selected image (1990000000011_operations-faulty, 1990000000013_operations-degraded)',
    );
    expect(readFileSync(statePath, 'utf8')).toBe(inventory);
    expect(await container('app-user')).toBe(serving);

    // A signal interrupts the deployment; a new reviewed selection supersedes it.
    const sleepyUser = await fixture.derive(
      'user',
      degradedUser,
      'apply-sleep',
      migration(
        '1990000000015_operations-sleep',
        'CREATE TABLE operations_sleep (id integer);\nSELECT pg_sleep(30);',
      ),
    );
    select({ user: sleepyUser, wallet: finalWallet });
    writeFileSync(reviewed, await fixture.ops('plan'));
    const applier = Bun.spawn(
      [
        'bun',
        '--no-env-file',
        'scripts/operations.ts',
        `--directory=${fixture.directory}`,
        'apply',
        `--plan=${reviewed}`,
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    const output = Promise.all([
      new Response(applier.stdout).text(),
      new Response(applier.stderr).text(),
    ]);
    try {
      await until(
        async () =>
          (await sql(
            'user',
            "SELECT count(*) FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND wait_event = 'PgSleep'",
          )) === '1',
      );
      applier.kill('SIGINT');
      expect(await applier.exited).toBe(130);
    } finally {
      if (applier.exitCode === null) applier.kill('SIGTERM');
      await applier.exited;
      await output;
    }
    expect((await output)[1]).toContain('Topology deployment incomplete');
    expect(progress()).toEqual([
      'promote:user:interrupted',
      'reconcile::not-started',
    ]);
    expect(record().attempts.at(-1)).toMatchObject({
      operation: 'apply',
      outcome: 'interrupted',
    });
    const interrupted = fixture.state().pendingDeployment;
    expect(existsSync(join(fixture.directory, '.operation-lock'))).toBe(false);
    expect(
      await fixture.compose(['ps', '--all', '--format', '{{.Name}}']),
    ).not.toContain('-command-');
    expect(applied('user')).toMatchObject({
      image: degradedUser,
      migration: { image: sleepyUser, result: 'interrupted' },
    });
    const interruptedTransitions = readdirSync(fixture.directory)
      .filter((file) => file.startsWith('transition-'))
      .map((file) =>
        transitionSchema.parse(
          JSON.parse(readFileSync(join(fixture.directory, file), 'utf8')),
        ),
      )
      .filter((transition) => transition.deployment === interrupted);
    expect(interruptedTransitions).toMatchObject([
      {
        status: 'interrupted',
        migration: { outcome: 'interrupted', completedAt: null },
      },
    ]);
    expect(
      await sql(
        'user',
        "SELECT count(*) FROM pg_tables WHERE tablename = 'operations_sleep'",
      ),
    ).toBe('0');
    expect(await container('app-user')).toBe('');
    select({ user: degradedUser, wallet: finalWallet });
    const superseding = await review();
    expect(superseding.code, superseding.stderr).toBe(0);
    // The stopped prior server is reported, never restarted implicitly.
    expect(superseding.stdout).toContain(
      'Applied applications not running: user',
    );
    expect(fixture.state().pendingDeployment).toBeUndefined();
    expect(
      JSON.parse(
        readFileSync(
          join(fixture.directory, `apply-${interrupted ?? 'missing'}.json`),
          'utf8',
        ),
      ) as unknown,
    ).toMatchObject({ status: 'superseded' });
    expect(await container('app-user')).toBe('');
    await fixture.ops('start', 'user');
    expect(await fixture.request('/v1/users')).toEqual(users);
  }, [fixture.cleanup]);
}, 900_000);

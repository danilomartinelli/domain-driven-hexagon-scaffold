import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
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

import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  createReadStream,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { withCleanup } from './cleanup';
import {
  imageDigest,
  readJson,
  writeJson,
  type Artifact,
  type InstallationState,
} from './operations-config';

type Compose = (
  args: string[],
  timeout?: number,
  cleanup?: boolean,
) => Promise<string>;
const metadataSchema = z.strictObject({
  application: z.string(),
  project: z.string(),
  image: imageDigest,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.iso.datetime(),
});

async function fileHash(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file))
    hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/** Passwords are read inside the owning database container, never put on a host command line. */
function ownerCommand(app: string, command: string): string[] {
  const db = app.replaceAll('-', '_');
  return [
    'exec',
    '-T',
    `postgres-${app}`,
    'sh',
    '-ec',
    `export PGHOST=127.0.0.1 PGDATABASE=${db} PGUSER=${db}_owner; export PGPASSWORD="$(cat /run/secrets/${app}-owner-password)"; ${command}`,
  ];
}

const historyQuery =
  "psql -X -At -v ON_ERROR_STOP=1 -c 'SELECT name FROM public.pgmigrations ORDER BY id'";

async function readHistory(
  app: string,
  compose: Compose,
  command: string,
): Promise<string[]> {
  const output = await compose(ownerCommand(app, command));
  return output ? output.split('\n') : [];
}

/** Applied migration names in order; fails when the database has no migration history. */
export function migrationHistory(
  app: string,
  compose: Compose,
): Promise<string[]> {
  return readHistory(app, compose, historyQuery);
}

/** Planning reads a database that was never migrated as having no applied migrations. */
export function appliedMigrations(
  app: string,
  compose: Compose,
): Promise<string[]> {
  return readHistory(
    app,
    compose,
    `if [ "$(psql -X -At -v ON_ERROR_STOP=1 -c "SELECT to_regclass('public.pgmigrations') IS NOT NULL")" = t ]; then ${historyQuery}; fi`,
  );
}

/** Stream the custom archive through Docker cp, avoiding captured binary output and size limits. */
export async function backupApplication(
  state: InstallationState,
  app: Artifact,
  output: string,
  compose: Compose,
): Promise<string> {
  const path = resolve(output);
  if (existsSync(path) || existsSync(`${path}.json`))
    throw new Error('Backup destination already exists');
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const remote = `/tmp/operations-${randomUUID()}.dump`;
  return withCleanup(async () => {
    await compose(
      ownerCommand(
        app.declaration.name,
        `umask 077; pg_dump --format=custom --file=${remote}`,
      ),
      300_000,
    );
    await compose(
      ['cp', `postgres-${app.declaration.name}:${remote}`, temporary],
      300_000,
    );
    chmodSync(temporary, 0o600);
    const metadata = {
      application: app.declaration.name,
      project: state.project,
      image: app.image,
      sha256: await fileHash(temporary),
      createdAt: new Date().toISOString(),
    };
    renameSync(temporary, path);
    writeJson(`${path}.json`, metadata);
    return path;
  }, [
    () => {
      rmSync(temporary, { force: true });
    },
    () =>
      compose(
        ['exec', '-T', `postgres-${app.declaration.name}`, 'rm', '-f', remote],
        30_000,
        true,
      ),
  ]);
}

export interface VerifiedArchive {
  path: string;
  metadata: z.infer<typeof metadataSchema>;
}

/** Refuse a foreign or altered archive, or running applications, before any change. */
export async function verifyArchive(
  state: InstallationState,
  app: Artifact,
  input: string,
  compose: Compose,
): Promise<VerifiedArchive> {
  const path = resolve(input);
  const metadata = metadataSchema.parse(readJson(`${path}.json`));
  if (
    metadata.application !== app.declaration.name ||
    metadata.project !== state.project ||
    metadata.sha256 !== (await fileHash(path))
  )
    throw new Error('Backup ownership or checksum does not match');
  const running = await compose([
    'ps',
    '--status',
    'running',
    '--quiet',
    ...state.applied.applications.map(
      (entry) => `app-${entry.declaration.name}`,
    ),
  ]);
  if (running)
    throw new Error(
      'Stop all applications before restoring; retained messages must be assessed before traffic resumes',
    );
  return { path, metadata };
}

/** Restore a verified archive into only its owning database; broker state is never changed. */
export async function restoreApplication(
  state: InstallationState,
  app: Artifact,
  { path, metadata }: VerifiedArchive,
  compose: Compose,
): Promise<void> {
  if (state.applied.applications.some((entry) => entry.declaration.exposure))
    await compose(['stop', '--timeout', '20', 'gateway']);
  const remote = `/tmp/operations-${randomUUID()}.dump`;
  // Keep every unresolved application gated, including failed/interrupted restores.
  const recoveryPath = join(state.directory, 'recovery.json');
  const pending = existsSync(recoveryPath)
    ? z
        .object({ applications: z.record(z.string(), z.unknown()) })
        .parse(readJson(recoveryPath)).applications
    : {};
  const recovery = {
    id: randomUUID(),
    backup: path,
    metadata,
    status: 'restoring',
  };
  pending[app.declaration.name] = recovery;
  writeJson(recoveryPath, { applications: pending });
  await withCleanup(async () => {
    await compose(
      ['cp', path, `postgres-${app.declaration.name}:${remote}`],
      300_000,
    );
    await compose(
      ownerCommand(
        app.declaration.name,
        // Materialize SQL first: a failed archive decode must not commit schema cleanup.
        // DROP OWNED also removes objects introduced after the backup, including FKs.
        // initdb's public schema is assumed to exist in its first archive; later
        // archives may recreate it through --clean after a previous restoration.
        `umask 077; pg_restore --clean --if-exists --no-owner --file=${remote}.sql ${remote}; psql -X --single-transaction -v ON_ERROR_STOP=1 -c 'DROP OWNED BY CURRENT_USER; CREATE SCHEMA public AUTHORIZATION CURRENT_USER; GRANT USAGE ON SCHEMA public TO PUBLIC;' -f ${remote}.sql`,
      ),
      300_000,
    );
    recovery.status = 'restored';
    writeJson(recoveryPath, { applications: pending });
  }, [
    () =>
      compose(
        [
          'exec',
          '-T',
          `postgres-${app.declaration.name}`,
          'rm',
          '-f',
          remote,
          `${remote}.sql`,
        ],
        30_000,
        true,
      ),
  ]);
}

export function assessRecovery(
  directory: string,
  assessmentFile?: string,
): void {
  const file = join(directory, 'recovery.json');
  if (!existsSync(file)) return;
  const recovery = z
    .object({
      applications: z.record(
        z.string(),
        z.object({ id: z.string(), status: z.literal('restored') }),
      ),
    })
    .parse(readJson(file));
  if (!assessmentFile)
    throw new Error(
      'Restore requires --assessment=<file> documenting data comparison and retained/pending messaging before startup',
    );
  const ids = Object.values(recovery.applications)
    .map((entry) => entry.id)
    .sort();
  const assessment = z
    .strictObject({
      recoveryIds: z
        .array(z.string())
        .refine(
          (supplied) =>
            JSON.stringify([...supplied].sort()) === JSON.stringify(ids),
          'Assess every pending restoration',
        ),
      dataComparison: z.string().min(20),
      messagingReview: z.string().min(20),
    })
    .parse(readJson(assessmentFile));
  writeJson(
    join(directory, `recovery-assessment-${randomUUID()}.json`),
    assessment,
  );
}

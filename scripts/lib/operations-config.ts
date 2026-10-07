import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { applicationDeclarationSchema } from '@starter/capabilities/declaration';

export const imageDigest = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9.:/_-]*@sha256:[a-f0-9]{64}$/,
    'Select an exact repository@sha256 image digest',
  );
const name = z
  .string()
  .regex(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/)
  .max(40);
export const httpsSchema = z.strictObject({
  bind: z.ipv4().default('0.0.0.0'),
  port: z.number().int().min(1).max(65535).default(443),
});
/** The operator's desired selection: `deployment.json` for the installation's lifetime. */
export const deploymentSchema = z.strictObject({
  name,
  images: z
    .record(name, imageDigest)
    .refine((value) => Object.keys(value).length > 0, 'Select applications'),
  https: httpsSchema.optional(),
});
export type DeploymentConfig = z.infer<typeof deploymentSchema>;
export const artifactSchema = z.strictObject({
  image: imageDigest,
  declaration: applicationDeclarationSchema,
});
export type Artifact = z.infer<typeof artifactSchema>;

const timestamp = z.iso.datetime();
/** Selecting an image, committing its migrations and verifying startup are separate outcomes. */
const appliedApplicationSchema = artifactSchema.extend({
  migration: z
    .strictObject({
      operation: z.enum(['migrate', 'update', 'apply', 'restore']),
      image: imageDigest,
      result: z.enum(['committed', 'restored', 'failed', 'interrupted']),
      at: timestamp,
    })
    .optional(),
  startup: z
    .strictObject({
      operation: z.enum(['start', 'update', 'rollback', 'apply']),
      image: imageDigest,
      readiness: z.enum(['http', 'full']),
      result: z.enum(['verified', 'pending', 'failed', 'interrupted']),
      at: timestamp,
    })
    .optional(),
});
const retainedSchema = z.strictObject({
  databases: z.array(
    z.strictObject({
      application: name,
      service: z.string(),
      volume: z.string(),
      database: z.string(),
      roles: z.array(z.string()),
      secrets: z.array(z.string()),
    }),
  ),
  broker: z
    .strictObject({
      service: z.string(),
      volume: z.string(),
      vhost: z.string(),
      username: z.string(),
      secrets: z.array(z.string()),
    })
    .optional(),
});
export const stateSchema = z.strictObject({
  version: z.literal(2),
  name,
  project: z.string(),
  owner: z.string(),
  directory: z.string(),
  // What the managed Compose project operates, with per-application outcomes.
  applied: z.strictObject({
    https: httpsSchema.optional(),
    applications: z.array(appliedApplicationSchema),
  }),
  // Owned durable identities outlive their applications' active selection.
  retained: retainedSchema,
  pendingTransitions: z.record(name, z.uuid()).optional(),
  // An incomplete topology deployment blocks image updates until continued or superseded.
  pendingDeployment: z.uuid().optional(),
});
export type InstallationState = z.infer<typeof stateSchema>;
export type AppliedApplication =
  InstallationState['applied']['applications'][number];
export type RetainedResources = InstallationState['retained'];

/** Version 1 kept the bootstrap selection beside the applied artifacts. */
const legacyStateSchema = z.strictObject({
  version: z.literal(1),
  project: z.string(),
  owner: z.string(),
  directory: z.string(),
  config: deploymentSchema,
  artifacts: z.array(artifactSchema),
  pendingTransitions: z.record(name, z.uuid()).optional(),
});

export function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function writeJson(path: string, value: unknown): void {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  renameSync(temporary, path);
}

/** A new inventory; its Compose project is fixed here and never renamed by desired edits. */
export function newInstallation(
  name: string,
  directory: string,
  applications: readonly Artifact[],
  https?: DeploymentConfig['https'],
): InstallationState {
  const project = `ddh-ops-${name}-${createHash('sha256').update(directory).digest('hex').slice(0, 8)}`;
  return {
    version: 2,
    name,
    project,
    owner: randomUUID(),
    directory,
    applied: { ...(https ? { https } : {}), applications: [...applications] },
    retained: retainResources(
      { project, retained: { databases: [] } },
      applications,
    ),
  };
}

/** Selected images keyed by application, compared without depending on key order. */
export function sameImages(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>,
): boolean {
  const entries = (value: Readonly<Record<string, string>>) =>
    JSON.stringify(
      Object.entries(value).sort(([a], [b]) => a.localeCompare(b)),
    );
  return entries(left) === entries(right);
}

export function sameHttps(
  left?: DeploymentConfig['https'],
  right?: DeploymentConfig['https'],
): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

export function appliedImages(
  applications: readonly Artifact[],
): Record<string, string> {
  return Object.fromEntries(
    applications.map((entry) => [entry.declaration.name, entry.image]),
  );
}

/**
 * Record the durable identities of newly applied applications. Existing entries
 * are never removed or renamed, so retained resources stay addressable after
 * their application or capability becomes inactive.
 */
export function retainResources(
  state: Pick<InstallationState, 'project' | 'retained'>,
  applications: readonly Artifact[],
): RetainedResources {
  const databases = [...state.retained.databases];
  for (const { declaration } of applications) {
    if (
      !declaration.persistence ||
      databases.some((entry) => entry.application === declaration.name)
    )
      continue;
    const database = declaration.name.replaceAll('-', '_');
    databases.push({
      application: declaration.name,
      service: `postgres-${declaration.name}`,
      volume: `${state.project}_postgres-${declaration.name}`,
      database,
      roles: [`${database}_owner`, `${database}_runtime`],
      secrets: ['admin', 'owner', 'runtime'].map(
        (role) => `${declaration.name}-${role}-password`,
      ),
    });
  }
  const broker =
    state.retained.broker ??
    (applications.some(({ declaration }) => declaration.messaging)
      ? {
          service: 'rabbitmq',
          volume: `${state.project}_rabbitmq`,
          vhost: state.project,
          username: 'scaffold',
          secrets: ['broker-password'],
        }
      : undefined);
  return { databases, ...(broker ? { broker } : {}) };
}

export type DesiredSelection =
  | { config: DeploymentConfig; document: Record<string, unknown> }
  | { error: string };

export interface Installation {
  directory: string;
  /** Applied and retained inventory; absent before the first preparation. */
  state?: InstallationState;
  desired: DesiredSelection;
  /** A version 1 inventory adopted in memory; operations other than plan record it. */
  adopted: boolean;
}

function readDesired(root: string): DesiredSelection {
  const path = join(root, 'deployment.json');
  if (!existsSync(path)) return { error: 'deployment.json is missing' };
  let document: unknown;
  try {
    document = readJson(path);
  } catch {
    return { error: 'deployment.json is not valid JSON' };
  }
  const result = deploymentSchema.safeParse(document);
  if (!result.success)
    return {
      error: `Invalid deployment.json: select applications with exact image digests and an optional HTTPS bind/port\n${z.prettifyError(result.error)}`,
    };
  return {
    config: result.data,
    document: document as Record<string, unknown>,
  };
}

/**
 * Inspection and shutdown use the recorded inventory; an edited, incomplete or
 * invalid desired selection is reported to the operations that need it.
 */
export function readInstallation(directory: string): Installation {
  const root = realpathSync(directory);
  const desired = readDesired(root);
  const path = join(root, 'state.json');
  if (!existsSync(path)) return { directory: root, desired, adopted: false };
  const recorded = readJson(path);
  const legacy = legacyStateSchema.safeParse(recorded);
  let state: InstallationState;
  if (legacy.success) {
    const { config, artifacts, ...identity } = legacy.data;
    state = {
      ...identity,
      version: 2,
      name: config.name,
      applied: {
        ...(config.https ? { https: config.https } : {}),
        applications: artifacts,
      },
      retained: { databases: [] },
    };
    state.retained = retainResources(state, artifacts);
  } else {
    state = stateSchema.parse(recorded);
  }
  if (state.directory !== root)
    throw new Error(
      'Inventory belongs to another directory; keep each installation directory stable',
    );
  return {
    directory: root,
    state,
    desired,
    adopted: legacy.success,
  };
}

/**
 * The desired selection, valid for this installation's recorded identity and,
 * for image commands, still selecting the application.
 */
export function desiredSelection(
  installation: Installation,
  application?: string,
): Extract<DesiredSelection, { config: DeploymentConfig }> {
  const { desired, state } = installation;
  if ('error' in desired) throw new Error(desired.error);
  if (state && desired.config.name !== state.name)
    throw new Error(
      `deployment.json name "${desired.config.name}" differs from installation "${state.name}"; the name is part of the recorded identity`,
    );
  if (application && !Object.hasOwn(desired.config.images, application))
    throw new Error(
      `${application} is absent from the desired selection; restore it in deployment.json before changing its image`,
    );
  return desired;
}

/** Image commands record their request as desired; this alone claims no outcome. */
export function selectDesiredImage(
  installation: Installation,
  application: string,
  image: string,
): void {
  const { config, document } = desiredSelection(installation, application);
  const selected = {
    ...document,
    images: { ...config.images, [application]: image },
  };
  writeJson(join(installation.directory, 'deployment.json'), selected);
  installation.desired = {
    config: deploymentSchema.parse(selected),
    document: selected,
  };
}

/** Report, without applying, a desired selection that differs from the applied one. */
export function desiredDivergence(
  installation: Installation,
): string | undefined {
  const { state } = installation;
  if (!state) return undefined;
  let config: DeploymentConfig;
  try {
    config = desiredSelection(installation).config;
  } catch (error) {
    return `The desired selection cannot be planned: ${error instanceof Error ? error.message : 'invalid'}`;
  }
  if (
    sameImages(appliedImages(state.applied.applications), config.images) &&
    sameHttps(state.applied.https, config.https)
  )
    return undefined;
  return 'The desired selection differs from the applied installation; review it with plan.';
}

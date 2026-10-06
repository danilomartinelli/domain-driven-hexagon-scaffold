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
export const deploymentSchema = z.strictObject({
  name,
  images: z
    .record(name, imageDigest)
    .refine((value) => Object.keys(value).length > 0, 'Select applications'),
  https: z
    .strictObject({
      bind: z.ipv4().default('0.0.0.0'),
      port: z.number().int().min(1).max(65535).default(443),
    })
    .optional(),
});
export const artifactSchema = z.strictObject({
  image: imageDigest,
  declaration: applicationDeclarationSchema,
});
export const stateSchema = z.strictObject({
  version: z.literal(1),
  project: z.string(),
  owner: z.string(),
  directory: z.string(),
  config: deploymentSchema,
  artifacts: z.array(artifactSchema),
});
export type DeploymentState = z.infer<typeof stateSchema>;
export type Artifact = z.infer<typeof artifactSchema>;

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

export function readDeployment(directory: string): {
  directory: string;
  config: z.infer<typeof deploymentSchema>;
  state?: DeploymentState;
} {
  const root = realpathSync(directory);
  const result = deploymentSchema.safeParse(
    readJson(join(root, 'deployment.json')),
  );
  if (!result.success)
    throw new Error(
      'Invalid deployment.json: select applications with exact image digests and an optional HTTPS bind/port',
    );
  const path = join(root, 'state.json');
  const state = existsSync(path)
    ? stateSchema.parse(readJson(path))
    : undefined;
  if (
    state &&
    (state.directory !== root ||
      JSON.stringify(state.config) !== JSON.stringify(result.data))
  )
    throw new Error(
      'Deployment identity/configuration changed; use update for images and keep the existing inventory',
    );
  return { directory: root, config: result.data, state };
}

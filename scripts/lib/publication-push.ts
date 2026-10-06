import { z } from 'zod';
import {
  digestSchema,
  planSchema,
  platformSchema,
  type PublicationPlan,
} from './publication';

const artifactSchema = planSchema.shape.applications.element.extend({
  id: digestSchema,
});
const receiptSchema = planSchema.extend({
  platform: platformSchema,
  hostArchitecture: z.enum(['amd64', 'arm64']),
  execution: z.enum(['native', 'emulated']),
  artifacts: z.array(artifactSchema).min(1),
});
export type ValidatedArtifact = z.infer<typeof artifactSchema>;
export interface RegistryManifest {
  digest: string;
  config?: string;
  manifests?: {
    digest: string;
    platform: { os: string; architecture: string };
  }[];
}
export interface PublicationRegistry {
  verifyArchive: (
    artifact: ValidatedArtifact,
    platform: string,
  ) => Promise<void>;
  requirePublic: (image: string) => Promise<void>;
  existing: (reference: string) => Promise<RegistryManifest | undefined>;
  push: (reference: string, id: string) => Promise<string>;
  merge: (
    reference: string,
    variants: { digest: string; platform: string }[],
  ) => Promise<string>;
}

/** A reusable commit tag must identify exactly the validated platform manifests. */
export function matchesVariants(
  manifest: RegistryManifest,
  variants: { digest?: string; platform: string }[],
): boolean {
  return (
    manifest.manifests?.length === 2 &&
    variants.every((variant) =>
      manifest.manifests?.some(
        (entry) =>
          entry.digest === variant.digest &&
          `${entry.platform.os}/${entry.platform.architecture}` ===
            variant.platform,
      ),
    )
  );
}

interface PublishedImages {
  repository: string;
  revision: string;
  images: {
    name: string;
    tag: string;
    reference: string;
    digest: string;
    variants: { platform: string; digest: string }[];
  }[];
}

/** Complete selection/architecture approval and public-package preflight precede every write. */
export async function publishValidated(
  plan: PublicationPlan,
  input: unknown[],
  registry: PublicationRegistry,
): Promise<PublishedImages> {
  const receipts = input.map((value) => receiptSchema.parse(value));
  if (
    receipts.length !== 2 ||
    new Set(receipts.map((receipt) => receipt.platform)).size !== 2
  )
    throw new Error('Publication requires validation of both architectures');
  for (const receipt of receipts) {
    if (
      receipt.repository !== plan.repository ||
      receipt.revision !== plan.revision
    )
      throw new Error('Validation source does not match the selected revision');
    if (
      JSON.stringify(receipt.applications) !==
        JSON.stringify(plan.applications) ||
      JSON.stringify(
        receipt.artifacts.map(({ name, image }) => ({ name, image })),
      ) !== JSON.stringify(plan.applications)
    )
      throw new Error(
        'Validation does not match the complete application selection',
      );
    if (
      (receipt.platform === `linux/${receipt.hostArchitecture}`) !==
      (receipt.execution === 'native')
    )
      throw new Error('Inconsistent architecture execution evidence');
    for (const artifact of receipt.artifacts)
      await registry.verifyArchive(artifact, receipt.platform);
  }
  const prepared = [];
  for (const app of plan.applications) {
    await registry.requirePublic(app.image);
    const variants = [];
    for (const receipt of receipts) {
      const artifact = receipt.artifacts.find(({ name }) => name === app.name);
      if (!artifact) throw new Error('Missing validated artifact');
      const tag = `${app.image}:sha-${plan.revision}-${receipt.platform.split('/')[1]}`;
      const existing = await registry.existing(tag);
      if (existing && existing.config !== artifact.id)
        throw new Error(
          `Commit tag already identifies a different artifact: ${tag}`,
        );
      variants.push({
        ...artifact,
        platform: receipt.platform,
        tag,
        digest: existing?.digest,
      });
    }
    const tag = `${app.image}:sha-${plan.revision}`;
    const existing = await registry.existing(tag);
    if (existing && !matchesVariants(existing, variants))
      throw new Error(
        `Commit tag already identifies different artifacts: ${tag}`,
      );
    prepared.push({ ...app, tag, existing, variants });
  }
  const images = [];
  for (const app of prepared) {
    const variants = [];
    for (const variant of app.variants) {
      const digest = digestSchema.parse(
        variant.digest ?? (await registry.push(variant.tag, variant.id)),
      );
      variants.push({ platform: variant.platform, digest });
    }
    const digest = digestSchema.parse(
      app.existing?.digest ?? (await registry.merge(app.tag, variants)),
    );
    images.push({
      name: app.name,
      tag: app.tag,
      reference: `${app.image}@${digest}`,
      digest,
      variants,
    });
  }
  return { repository: plan.repository, revision: plan.revision, images };
}

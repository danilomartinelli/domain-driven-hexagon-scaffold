import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { workspaceRoot } from '../../database/environment';
import { runCommand } from './command';
import { digestSchema, type PublicationPlan } from './publication';
import {
  matchesVariants,
  type PublicationRegistry,
  type RegistryManifest,
} from './publication-push';

/** Registry operations are separate from build/execution, and never receive application settings. */
export function ghcrRegistry(
  plan: PublicationPlan,
  directory: string,
  request: (url: string, options: RequestInit) => Promise<Response> = fetch,
  signal?: AbortSignal,
): PublicationRegistry {
  const command = async (args: string[]) => {
    const result = await runCommand(args, {
      cwd: workspaceRoot,
      timeout: 300_000,
      maxOutput: 1_000_000,
      cancellation: signal ? { signal, graceMs: 5_000 } : undefined,
    });
    if (result.code !== 0)
      throw new Error(
        `Registry command failed (${String(result.code)}): ${result.stderr}`,
      );
    return result.stdout.trim();
  };
  const requestSignal = () =>
    signal
      ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
      : AbortSignal.timeout(30_000);
  const existing = async (
    reference: string,
  ): Promise<RegistryManifest | undefined> => {
    const match =
      /^ghcr\.io\/(.+?)(?::(sha-[a-f0-9]{40}(?:-(?:amd64|arm64))?)|@(sha256:[a-f0-9]{64}))$/.exec(
        reference,
      );
    if (!match) throw new Error('Invalid GHCR reference');
    const [, name, tag, digest] = match;
    // Deliberately anonymous, and refreshed across potentially long uploads.
    const authorization = await request(
      `https://ghcr.io/token?service=ghcr.io&scope=${encodeURIComponent(`repository:${name}:pull`)}`,
      { signal: requestSignal() },
    );
    if (!authorization.ok)
      throw new Error(
        `Anonymous GHCR token failed: ${String(authorization.status)}`,
      );
    const token = z
      .object({ token: z.string().min(1) })
      .parse(await authorization.json()).token;
    const response = await request(
      `https://ghcr.io/v2/${name}/manifests/${tag || digest}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept:
            'application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json',
        },
        signal: requestSignal(),
      },
    );
    if (response.status === 404) return undefined;
    if (!response.ok)
      throw new Error(
        `Anonymous GHCR manifest failed: ${String(response.status)}`,
      );
    const bytes = await response.text();
    const actualDigest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    if (digest && digest !== actualDigest)
      throw new Error('Registry manifest digest mismatch');
    const manifest = z
      .object({
        config: z.object({ digest: digestSchema }).optional(),
        manifests: z
          .array(
            z.object({
              digest: digestSchema,
              platform: z.object({ os: z.string(), architecture: z.string() }),
            }),
          )
          .optional(),
      })
      .parse(JSON.parse(bytes));
    return {
      digest: actualDigest,
      config: manifest.config?.digest,
      manifests: manifest.manifests,
    };
  };
  return {
    existing,
    verifyArchive: async (artifact, platform) => {
      await command([
        'docker',
        'image',
        'load',
        '--input',
        join(directory, platform.replace('/', '-'), `${artifact.name}.tar`),
      ]);
      const [image] = z
        .array(
          z.object({
            Id: z.literal(artifact.id),
            Os: z.literal('linux'),
            Architecture: z.literal(platform.split('/')[1]),
            Config: z.object({ Labels: z.record(z.string(), z.string()) }),
          }),
        )
        .length(1)
        .parse(
          JSON.parse(
            await command(['docker', 'image', 'inspect', artifact.id]),
          ),
        );
      if (
        image.Config.Labels['org.opencontainers.image.revision'] !==
          plan.revision ||
        image.Config.Labels['org.opencontainers.image.source'] !==
          `https://github.com/${plan.repository}`
      )
        throw new Error('Archive provenance differs from the validated source');
    },
    requirePublic: async (image) => {
      const [owner, ...parts] = image.slice('ghcr.io/'.length).split('/');
      const kind = await command([
        'gh',
        'api',
        `users/${owner}`,
        '--jq',
        '.type',
      ]);
      const visibility = await command([
        'gh',
        'api',
        `${kind === 'Organization' ? 'orgs' : 'users'}/${owner}/packages/container/${encodeURIComponent(parts.join('/'))}`,
        '--jq',
        '.visibility',
      ]);
      if (visibility !== 'public')
        throw new Error(
          `Package must already be public: ${image}; see docs/publication.md`,
        );
    },
    push: async (reference, id) => {
      await command(['docker', 'image', 'tag', id, reference]);
      await command(['docker', 'image', 'push', reference]);
      const published = await existing(reference);
      if (!published || published.config !== id)
        throw new Error('Published image differs from the validated artifact');
      return published.digest;
    },
    merge: async (reference, variants) => {
      const image = reference.split(':')[0];
      await command([
        'docker',
        'buildx',
        'imagetools',
        'create',
        '--tag',
        reference,
        ...variants.map(({ digest }) => `${image}@${digest}`),
      ]);
      const published = await existing(reference);
      if (!published || !matchesVariants(published, variants))
        throw new Error(
          'Published index differs from the validated architectures',
        );
      return published.digest;
    },
  };
}

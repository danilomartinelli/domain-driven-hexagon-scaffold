import { z } from 'zod';
import type { EnvironmentManifest } from '../../database/environment';

/** Remove this run's rebuildable images, including superseded untagged builds. */
export async function removeDevelopmentImages(
  manifest: EnvironmentManifest,
  execute: (args: string[]) => Promise<string>,
): Promise<void> {
  if (manifest.environment !== 'development') return;
  const ids = await execute([
    'docker',
    'image',
    'ls',
    '--quiet',
    '--filter',
    `label=dev.starter.project=${manifest.project}`,
  ]);
  if (!ids) return;
  const images = z
    .array(
      z.object({
        Id: z.string(),
        RepoTags: z.array(z.string()).nullable(),
        Config: z.object({ Labels: z.record(z.string(), z.string()) }),
      }),
    )
    .parse(
      JSON.parse(
        await execute([
          'docker',
          'image',
          'inspect',
          ...new Set(ids.split(/\s+/)),
        ]),
      ),
    );
  for (const image of images) {
    if (
      image.Config.Labels['dev.starter.owner'] !== manifest.owner ||
      image.Config.Labels['dev.starter.project'] !== manifest.project
    )
      throw new Error('Refusing image owned by another environment.');
  }
  for (const image of images) {
    const tags = image.RepoTags ?? [];
    const ownedTags = tags.filter(
      (tag) =>
        tag.startsWith(`${manifest.project}-`) && tag.endsWith(':development'),
    );
    // Remove tags individually so unrelated aliases survive. Never force removal
    // of an image still in use by a container.
    const targets = tags.length ? ownedTags : [image.Id];
    if (targets.length) await execute(['docker', 'image', 'rm', ...targets]);
  }
}

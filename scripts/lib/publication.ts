import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { selectedApplications } from '../../database/topology';
import { workspaceRoot } from '../../database/environment';

export const platformSchema = z.enum(['linux/amd64', 'linux/arm64']);
export const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const planSchema = z.object({
  repository: z.string().regex(/^[a-z0-9-]+\/[a-z0-9_.-]+$/),
  revision: z.string().regex(/^[a-f0-9]{40}$/),
  applications: z
    .array(
      z.object({
        name: z.string().regex(/^[a-z][a-z0-9-]*$/),
        image: z.string().regex(/^ghcr\.io\/[a-z0-9_./-]+$/),
      }),
    )
    .min(1),
});
export type PublicationPlan = z.infer<typeof planSchema>;

export function publicationPlan(
  selection: string,
  repository: string,
  revision: string,
): PublicationPlan {
  const identity = z
    .object({
      packageName: z
        .string()
        .regex(/^(?:@[a-z0-9_.-]+\/)?[a-z0-9][a-z0-9._-]*$/),
    })
    .parse(
      JSON.parse(
        readFileSync(`${workspaceRoot}/scaffold.identity.json`, 'utf8'),
      ),
    );
  const owner = repository.toLowerCase().split('/')[0];
  return planSchema.parse({
    repository: repository.toLowerCase(),
    revision,
    applications: selectedApplications(
      selection === 'all' ? undefined : [selection],
    ).map(({ name }) => ({
      name,
      image: `ghcr.io/${owner}/${identity.packageName.replace(/^@/, '')}/${name}`,
    })),
  });
}

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { ApplicationDeclaration } from '@starter/capabilities/declaration';

const integration = z.strictObject({
  dependencies: z.array(z.string()),
  paths: z.array(
    z
      .string()
      .regex(/^[\w.-]+(?:\/[\w.-]+)*$/)
      .refine(
        (path) =>
          !path.split('/').some((part) => part === '.' || part === '..'),
        'Integration paths must stay inside the application',
      ),
  ),
});
const manifestSchema = z.union([
  z.array(z.string()),
  z.strictObject({
    dependencies: z.array(z.string()),
    integrations: z.strictObject({
      persistence: integration.optional(),
      messaging: integration.optional(),
      exposure: integration.optional(),
    }),
  }),
]);

/** Author-owned distribution inputs selected by the same runtime declaration. */
export function distributionSelection(
  directory: string,
  declaration: ApplicationDeclaration,
): { dependencies: string[]; excludedPaths: string[] } {
  const manifest = manifestSchema.parse(
    JSON.parse(readFileSync(join(directory, 'distribution.json'), 'utf8')),
  );
  const excludedPaths = declaration.persistence
    ? []
    : ['database/migrations', 'database/seeds'];
  if (Array.isArray(manifest)) return { dependencies: manifest, excludedPaths };
  const dependencies = [...manifest.dependencies];
  for (const capability of ['persistence', 'messaging', 'exposure'] as const) {
    const selected = manifest.integrations[capability];
    if (!selected) continue;
    if (declaration[capability]) dependencies.push(...selected.dependencies);
    else excludedPaths.push(...selected.paths);
  }
  return { dependencies: [...new Set(dependencies)], excludedPaths };
}

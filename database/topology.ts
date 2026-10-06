import {
  discoverApplications,
  type ApplicationDeclaration,
} from '@starter/capabilities/declaration';
import { preflightApplication } from '@starter/capabilities/composition';

/** Validate only the selected sources; inspection/shutdown use retained inventory. */
export function validateApplications(
  declarations: readonly ApplicationDeclaration[],
): void {
  for (const declaration of declarations)
    preflightApplication(
      new URL(`../src/apps/${declaration.name}/`, import.meta.url),
    );
}

/** The selected declarations are also the reusable input to environment renderers. */
export function selectedApplications(
  selection?: readonly string[],
  { retainMissing = false }: { retainMissing?: boolean } = {},
): ApplicationDeclaration[] {
  const declarations = discoverApplications(
    new URL('../src/apps/', import.meta.url),
  );
  if (!selection) return declarations;
  if (new Set(selection).size !== selection.length)
    throw new Error('Select distinct applications');
  return selection
    .filter(
      (name) => !retainMissing || declarations.some((app) => app.name === name),
    )
    .map((name) => {
      const declaration = declarations.find((app) => app.name === name);
      if (!declaration) throw new Error(`Unknown application: ${name}`);
      return declaration;
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

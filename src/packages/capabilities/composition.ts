import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  readApplicationDeclaration,
  type ApplicationDeclaration,
} from './declaration';

const capability = z.enum(['persistence', 'messaging', 'exposure']);
type Capability = z.infer<typeof capability>;
const distinct = (values: readonly unknown[]) =>
  new Set(values).size === values.length;

/** Author-owned registrations; selections remain in application.json. */
const applicationCompositionSchema = z.strictObject({
  integrations: z
    .array(capability)
    .refine(distinct, 'Integrations must be distinct'),
  groups: z
    .array(
      z.strictObject({
        name: z.string().regex(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/),
        requires: z
          .array(capability)
          .refine(distinct, 'Requirements must be distinct'),
        // Only business exposure adapters may be deliberately withdrawn.
        exposure: z.literal(true).optional(),
      }),
    )
    .refine(
      (groups) => distinct(groups.map((group) => group.name)),
      'Group names must be distinct',
    ),
});

export type ApplicationComposition = z.infer<
  typeof applicationCompositionSchema
>;

/** A credential-free incompatibility diagnostic safe for public commands. */
export class ApplicationCompatibilityError extends Error {}

export function readApplicationComposition(
  directory: string | URL,
): ApplicationComposition {
  const path =
    typeof directory === 'string' ? directory : fileURLToPath(directory);
  let parsed: ReturnType<typeof applicationCompositionSchema.safeParse>;
  try {
    parsed = applicationCompositionSchema.safeParse(
      JSON.parse(readFileSync(join(path, 'composition.json'), 'utf8')),
    );
  } catch {
    throw new Error(
      'Missing or invalid composition.json; register application functionality and prepared integrations',
    );
  }
  if (!parsed.success)
    throw new Error(
      'Invalid composition.json; register distinct groups and known capabilities',
    );
  return parsed.data;
}

/** Reject incompatibility without reading credentials or loading any adapter. */
export function assertApplicationCompatibility(
  declaration: ApplicationDeclaration,
  composition: ApplicationComposition,
): void {
  for (const name of capability.options) {
    if (declaration[name] && !composition.integrations.includes(name))
      throw new ApplicationCompatibilityError(
        `Application ${declaration.name}: ${name} integration is not prepared; implement and register it before enabling ${name}`,
      );
  }
  for (const group of composition.groups) {
    if (group.exposure && !declaration.exposure) continue;
    for (const required of group.requires)
      if (!declaration[required])
        throw new ApplicationCompatibilityError(
          `Application ${declaration.name}: group ${group.name} requires ${required}; enable its prepared integration or explicitly revise the application's functionality`,
        );
  }
}

/** Public source/artifact preflight, independent of Nest and external services. */
export function preflightApplication(
  directory: string | URL,
): ApplicationDeclaration {
  const path =
    typeof directory === 'string' ? directory : fileURLToPath(directory);
  const declaration = readApplicationDeclaration(
    join(path, 'application.json'),
  );
  assertApplicationCompatibility(declaration, readApplicationComposition(path));
  return declaration;
}

/**
 * The validated registrations select the factories used by actual composition.
 * Check the whole binding before evaluating any factory; no group is inferred or
 * silently removed to make a disabled dependency appear compatible.
 */
export function composeApplication<Part>(
  declaration: ApplicationDeclaration,
  composition: ApplicationComposition,
  factories: {
    integrations: Partial<Record<Capability, () => Part>>;
    groups: Record<string, () => Part>;
  },
): Part[] {
  assertApplicationCompatibility(declaration, composition);
  for (const [names, bindings] of [
    [composition.integrations, factories.integrations],
    [composition.groups.map((group) => group.name), factories.groups],
  ] as const) {
    if (
      names.length !== Object.keys(bindings).length ||
      names.some((name) => !Object.hasOwn(bindings, name))
    )
      throw new Error(
        `Application ${declaration.name}: composition registrations and factories differ; bind every registered integration and functionality group`,
      );
  }
  const parts: Part[] = [];
  for (const name of composition.integrations) {
    const factory = factories.integrations[name];
    if (declaration[name] && factory) parts.push(factory());
  }
  for (const group of composition.groups) {
    if (!group.exposure || declaration.exposure)
      parts.push(factories.groups[group.name]());
  }
  return parts;
}

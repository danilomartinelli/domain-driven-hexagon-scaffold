import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const applicationName = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

export const applicationDeclarationSchema = z.strictObject({
  name: z.string().regex(applicationName),
  persistence: z.boolean(),
  messaging: z.boolean(),
  exposure: z.boolean(),
  routes: z
    .array(
      z.strictObject({
        name: z.string().regex(applicationName),
        paths: z.array(z.string().regex(/^(\/|~\/)/)).min(1),
        methods: z
          .array(
            z.enum([
              'GET',
              'POST',
              'PUT',
              'PATCH',
              'DELETE',
              'OPTIONS',
              'HEAD',
            ]),
          )
          .min(1)
          .optional(),
        stripPath: z.boolean(),
        upstreamPath: z.string().startsWith('/').optional(),
      }),
    )
    .refine(
      (routes) =>
        new Set(routes.map((route) => route.name)).size === routes.length,
      'Route names must be distinct',
    )
    .optional(),
});

/**
 * An application's independently selected capabilities. Disabled capabilities
 * contribute no configuration, adapters, infrastructure or readiness dependency.
 */
export type ApplicationDeclaration = Readonly<
  z.infer<typeof applicationDeclarationSchema>
>;

/** Read and validate one `application.json` without trusting its shape. */
export function readApplicationDeclaration(
  file: string | URL,
): ApplicationDeclaration {
  const path = typeof file === 'string' ? file : fileURLToPath(file);
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`Invalid application declaration: ${path}`, {
      cause: error,
    });
  }
  const parsed = applicationDeclarationSchema.safeParse(value);
  if (!parsed.success)
    throw new Error(
      `Invalid application declaration: ${path}: ${z.prettifyError(parsed.error)}`,
    );
  return parsed.data;
}

/**
 * Each immediate subdirectory with an `application.json` declares itself; the
 * directory listing, not a central name registry, decides which ones exist.
 * Undeclared directories are skipped so unrelated tooling keeps working; the
 * workflow guardrail requires every application project to declare itself.
 */
export function discoverApplications(
  root: string | URL,
): ApplicationDeclaration[] {
  const directory = typeof root === 'string' ? root : fileURLToPath(root);
  return readdirSync(directory, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        existsSync(join(directory, entry.name, 'application.json')),
    )
    .map((entry) => {
      const file = join(directory, entry.name, 'application.json');
      const declaration = readApplicationDeclaration(file);
      if (declaration.name !== entry.name)
        throw new Error(`${file} must declare name "${entry.name}"`);
      return declaration;
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * Business REST/GraphQL adapters and their modules are composed only when the
 * declaration enables exposure; operational health endpoints stay outside.
 */
export function exposedAdapters<Adapter>(
  declaration: ApplicationDeclaration,
  adapters: readonly Adapter[],
): Adapter[] {
  return declaration.exposure ? [...adapters] : [];
}

/** `order-history` reads `ORDER_HISTORY_*` settings. */
export function environmentPrefix(name: string): string {
  if (!applicationName.test(name))
    throw new Error(`Invalid application name: ${name}`);
  return name.replaceAll('-', '_').toUpperCase();
}

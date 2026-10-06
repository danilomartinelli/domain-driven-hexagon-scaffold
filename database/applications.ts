import { existsSync, readdirSync } from 'node:fs';
import {
  discoverApplications,
  environmentPrefix,
} from '@starter/capabilities/declaration';
import { preflightApplication } from '@starter/capabilities/composition';

/** Each persistent application owns its content; orchestration iterates this view. */
export interface DatabaseApplication {
  name: string;
  prefix: string;
  migrations: URL;
  seeds: URL[];
  /**
   * Restricted login role that the application's migrations grant access to.
   * When set, `<prefix>_USERNAME`/`_PASSWORD` select this role for the running
   * application, and migrations/seeds use the owner role through
   * `<prefix>_MIGRATION_USERNAME`/`_PASSWORD`.
   */
  runtimeRole?: string;
}

const apps = new URL('../src/apps/', import.meta.url);
const declarations = discoverApplications(apps);

/** Seeds run in file-name order after migrations, in one transaction. */
function seeds(directory: URL): URL[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((file) => file.endsWith('.sql'))
    .sort()
    .map((file) => new URL(file, directory));
}

/**
 * Derived from each `src/apps/<name>/application.json` that declares persistence;
 * there is no separate list of application names to edit.
 */
export const applications: DatabaseApplication[] = declarations
  .filter((declaration) => declaration.persistence)
  .map(({ name }) => ({
    name,
    prefix: `${environmentPrefix(name)}_DB`,
    migrations: new URL(`${name}/database/migrations/`, apps),
    seeds: seeds(new URL(`${name}/database/seeds/`, apps)),
    runtimeRole: `${name.replaceAll('-', '_')}_runtime`,
  }));

export function selectApplication(
  name = process.env.DATABASE_APP ?? 'user',
): DatabaseApplication {
  if (declarations.some((entry) => entry.name === name))
    preflightApplication(new URL(`${name}/`, apps));
  const application = applications.find((entry) => entry.name === name);
  if (!application) throw new Error(`Unknown database application: ${name}`);
  return application;
}

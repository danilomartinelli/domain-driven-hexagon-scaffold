import { readFileSync } from 'node:fs';
import { z } from 'zod';

/** Artifact-local registry: there is no selectable sibling database or workspace manifest. */
export function selectApplication(): {
  name: string;
  prefix: string;
  runtimeRole?: string;
  migrations: URL;
} {
  const { service, database } = z
    .object({
      service: z.string(),
      database: z.object({
        prefix: z.string(),
        runtimeRole: z.string().optional(),
        migrations: z.string(),
      }),
    })
    .parse(
      JSON.parse(
        readFileSync(new URL('../distribution.json', import.meta.url), 'utf8'),
      ),
    );
  if (process.env.DATABASE_APP && process.env.DATABASE_APP !== service)
    throw new Error(`This distribution owns only ${service}`);
  return {
    name: service,
    prefix: database.prefix,
    runtimeRole: database.runtimeRole,
    migrations: new URL(`../${database.migrations}/`, import.meta.url),
  };
}

export function databaseTarget(): {
  app: ReturnType<typeof selectApplication>;
  connection: {
    host: string;
    port: number;
    database: string;
    user: string;
    password: string;
  };
} {
  const app = selectApplication();
  const value = (suffix: string) => {
    const setting = process.env[`${app.prefix}_${suffix}`];
    if (!setting) throw new Error(`Missing ${app.prefix}_${suffix}`);
    return setting;
  };
  const port = z.coerce.number().int().min(1).max(65535).parse(value('PORT'));
  const credential = app.runtimeRole ? 'MIGRATION_' : '';
  const user = value(`${credential}USERNAME`);
  if (user === app.runtimeRole)
    throw new Error(
      'Migrations require the owner role, not runtime credentials',
    );
  return {
    app,
    connection: {
      host: value('HOST'),
      port,
      database: value('NAME'),
      user,
      password: value(`${credential}PASSWORD`),
    },
  };
}

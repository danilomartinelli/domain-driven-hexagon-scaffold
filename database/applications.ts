/** Each application owns its content; orchestration iterates this registry. */
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
export const applications: DatabaseApplication[] = [
  {
    name: 'legacy',
    prefix: 'DB',
    migrations: new URL('./migrations/', import.meta.url),
    seeds: [
      new URL('./seeds/users.seed.sql', import.meta.url),
      new URL('./seeds/wallets.seed.sql', import.meta.url),
    ],
  },
  {
    name: 'wallet',
    prefix: 'WALLET_DB',
    migrations: new URL(
      '../src/apps/wallet/database/migrations/',
      import.meta.url,
    ),
    seeds: [
      new URL(
        '../src/apps/wallet/database/seeds/wallets.seed.sql',
        import.meta.url,
      ),
    ],
    runtimeRole: 'wallet_runtime',
  },
];

export function selectApplication(
  name = process.env.DATABASE_APP ?? 'legacy',
): DatabaseApplication {
  const application = applications.find((entry) => entry.name === name);
  if (!application) throw new Error(`Unknown database application: ${name}`);
  return application;
}

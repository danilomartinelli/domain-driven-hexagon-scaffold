/** Each application owns its content; orchestration iterates this registry. */
export interface DatabaseApplication {
  name: string;
  prefix: string;
  migrations: URL;
  seeds: URL[];
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
];

export function selectApplication(
  name = process.env.DATABASE_APP ?? 'legacy',
): DatabaseApplication {
  const application = applications.find((entry) => entry.name === name);
  if (!application) throw new Error(`Unknown database application: ${name}`);
  return application;
}

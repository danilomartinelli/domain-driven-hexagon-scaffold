import '../src/configs/load-env';
import { assertTestEnvironment } from './environment';
import { selectApplication, type DatabaseApplication } from './applications';

/**
 * Resolve the selected application's connection only after validating the full
 * test set. Applications with a runtime role migrate and seed as the owner.
 */
export function databaseTarget(): {
  app: DatabaseApplication;
  connection: {
    host: string;
    port: number;
    user: string;
    password: string;
    database: string;
  };
} {
  if (process.env.NODE_ENV === 'test') assertTestEnvironment();
  const app = selectApplication();
  const value = (suffix: string) => {
    const setting = process.env[`${app.prefix}_${suffix}`];
    if (!setting) throw new Error(`Missing ${app.prefix}_${suffix}`);
    return setting;
  };
  const port = Number(value('PORT'));
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('Invalid database port');
  const credentialPrefix = app.runtimeRole ? 'MIGRATION_' : '';
  return {
    app,
    connection: {
      host: value('HOST'),
      port,
      user: value(`${credentialPrefix}USERNAME`),
      password: value(`${credentialPrefix}PASSWORD`),
      database: value('NAME'),
    },
  };
}

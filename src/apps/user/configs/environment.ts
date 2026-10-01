import { get } from 'env-var';

/**
 * User reads only its own settings from the process environment and loads
 * no dotenv file. `env:exec` supplies them from the selected environment;
 * `USER_DB_USERNAME` is the restricted runtime role, not the migration owner.
 */
export function userHttpPort(): number {
  return get('USER_HTTP_PORT').required().asPortNumber();
}

export function userDatabaseUri(): string {
  const setting = (name: string) =>
    encodeURIComponent(get(`USER_DB_${name}`).required().asString());
  const port = get('USER_DB_PORT').required().asPortNumber();
  return `postgres://${setting('USERNAME')}:${setting('PASSWORD')}@${setting('HOST')}:${String(port)}/${setting('NAME')}`;
}

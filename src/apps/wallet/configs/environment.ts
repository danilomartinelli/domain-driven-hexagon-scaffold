import { get } from 'env-var';

/**
 * Wallet reads only its own settings from the process environment and loads
 * no dotenv file. `env:exec` supplies them from the selected environment;
 * `WALLET_DB_USERNAME` is the restricted runtime role, not the migration owner.
 */
export function walletHttpPort(): number {
  return get('WALLET_HTTP_PORT').required().asPortNumber();
}

export function walletDatabaseUri(): string {
  const setting = (name: string) =>
    encodeURIComponent(get(`WALLET_DB_${name}`).required().asString());
  const port = get('WALLET_DB_PORT').required().asPortNumber();
  return `postgres://${setting('USERNAME')}:${setting('PASSWORD')}@${setting('HOST')}:${String(port)}/${setting('NAME')}`;
}

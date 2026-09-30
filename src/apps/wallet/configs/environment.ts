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

export function walletRabbitMqOptions(): {
  hostname: string;
  port: number;
  username: string;
  password: string;
  vhost: string;
  heartbeat: number;
} {
  const setting = (name: string) =>
    get(`RABBITMQ_${name}`).required().asString();
  return {
    hostname: setting('HOST'),
    port: get('RABBITMQ_PORT').required().asPortNumber(),
    username: setting('USERNAME'),
    password: setting('PASSWORD'),
    vhost: setting('VHOST'),
    heartbeat: 2,
  };
}

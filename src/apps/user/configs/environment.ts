import { get } from 'env-var';
import { configurationValue } from '@starter/nest-support/configuration';

function required(name: string): string {
  const value = configurationValue(name);
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

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
    encodeURIComponent(required(`USER_DB_${name}`));
  const port = get('USER_DB_PORT').required().asPortNumber();
  return `postgres://${setting('USERNAME')}:${setting('PASSWORD')}@${setting('HOST')}:${String(port)}/${setting('NAME')}`;
}

export function userRabbitMqOptions(): {
  hostname: string;
  port: number;
  username: string;
  password: string;
  vhost: string;
  heartbeat: number;
} {
  const setting = (name: string) => required(`RABBITMQ_${name}`);
  return {
    hostname: setting('HOST'),
    port: get('RABBITMQ_PORT').required().asPortNumber(),
    username: setting('USERNAME'),
    password: setting('PASSWORD'),
    vhost: setting('VHOST'),
    heartbeat: 2,
  };
}

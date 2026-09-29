import { get } from 'env-var';
import './load-env';

// https://github.com/Sairyss/backend-best-practices#configuration

export const databaseConfig = {
  type: 'postgres',
  host: get('DB_HOST').required().asString(),
  port: get('DB_PORT').required().asIntPositive(),
  username: get('DB_USERNAME').required().asString(),
  password: get('DB_PASSWORD').required().asString(),
  database: get('DB_NAME').required().asString(),
};

export const postgresConnectionUri = `postgres://${encodeURIComponent(
  databaseConfig.username,
)}:${encodeURIComponent(databaseConfig.password)}@${databaseConfig.host}:${String(
  databaseConfig.port,
)}/${encodeURIComponent(databaseConfig.database)}`;

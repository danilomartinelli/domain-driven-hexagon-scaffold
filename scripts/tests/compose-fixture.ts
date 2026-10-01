import { randomUUID } from 'node:crypto';
import { composeConfiguration } from '../lib/compose';

export function composeProbeConfiguration(
  username: string,
  password: string,
): Record<string, unknown> {
  return composeConfiguration({
    environment: 'test',
    run: 'compose-probe',
    project: 'compose-probe',
    owner: randomUUID(),
    status: 'starting',
    databases: [
      {
        app: 'wallet',
        prefix: 'WALLET_DB',
        host: '127.0.0.1',
        port: 5432,
        username: 'owner',
        password: 'fixture-owner',
        database: 'wallet',
        runtime: { username, password },
      },
    ],
    broker: {
      port: 5672,
      managementPort: 15672,
      username: 'fixture',
      password: 'fixture-broker',
      vhost: 'compose-probe',
    },
    gateway: {
      name: 'compose-probe-gateway',
      host: 'host.docker.internal',
      proxyPort: 8000,
      adminPort: 8001,
      userPort: 3000,
      walletPort: 3001,
    },
  });
}

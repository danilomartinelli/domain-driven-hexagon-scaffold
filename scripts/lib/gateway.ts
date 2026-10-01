import { readFileSync } from 'node:fs';
import type { EnvironmentManifest } from '../../database/environment';

/** Render JSON values, not shell expressions, into the versioned route template. */
export function gatewayConfiguration(
  gateway: EnvironmentManifest['gateway'],
): string {
  const template = readFileSync(
    new URL('../../docker/kong.json', import.meta.url),
    'utf8',
  );
  return template
    .replaceAll('"${GATEWAY_HOST}"', () => JSON.stringify(gateway.host))
    .replaceAll('"${USER_HTTP_PORT}"', String(gateway.userPort))
    .replaceAll('"${WALLET_HTTP_PORT}"', String(gateway.walletPort));
}

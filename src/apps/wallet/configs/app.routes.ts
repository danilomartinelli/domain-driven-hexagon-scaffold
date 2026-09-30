/**
 * Wallet routes with their API version
 * https://github.com/Sairyss/backend-best-practices#api-versioning
 */
export const routesV1 = {
  version: 'v1',
  wallet: {
    byUser: 'wallets/by-user/:userId',
  },
};

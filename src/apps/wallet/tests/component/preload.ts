import { assertTestEnvironment } from '../../../../../database/environment';

// Reject every configured target before starting Wallet or opening a connection.
assertTestEnvironment();
await import('./wallet-process');

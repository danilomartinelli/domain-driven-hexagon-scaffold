import { plugin } from 'bun';
import { fileURLToPath } from 'node:url';

// Only the protocol decoder changes; real Wallet use cases and persistence run.
plugin({
  name: 'compatible-consumer-fixture',
  setup(build) {
    build.onLoad(
      { filter: /\/src\/packages\/integration-contracts\/user-created\.ts$/ },
      () => {
        console.error('Compatible consumer fixture loaded');
        return {
          contents: `export { decodeUserCreatedEvent, isUserCreatedIdentity, userCreatedDestination } from ${JSON.stringify(fileURLToPath(new URL('./additive-consumer.ts', import.meta.url)))};`,
          loader: 'ts',
        };
      },
    );
  },
});

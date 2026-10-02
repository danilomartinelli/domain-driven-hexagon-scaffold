import { plugin } from 'bun';
import { fileURLToPath } from 'node:url';

// Exercise the same colored service logs as CI, even under a NO_COLOR parent.
delete process.env.NO_COLOR;
process.env.FORCE_COLOR = '1';

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

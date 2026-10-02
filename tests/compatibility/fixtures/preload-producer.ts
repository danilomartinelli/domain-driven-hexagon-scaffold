import { plugin } from 'bun';

// Only the wire mapper changes; the real User transaction/outbox/publisher run.
plugin({
  name: 'compatible-producer-fixture',
  setup(build) {
    build.onLoad(
      { filter: /\/src\/apps\/user\/messaging\/user-created-event\.ts$/ },
      async () => ({
        contents: await Bun.file(
          new URL('./additive-producer.ts', import.meta.url),
        ).text(),
        loader: 'ts',
      }),
    );
  },
});

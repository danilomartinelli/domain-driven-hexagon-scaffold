import type { ApplicationFactories } from '@starter/nest-support/composition';

// These invalid author bindings must remain compile errors without starting Nest.
export const missingProbe: ApplicationFactories = {
  integrations: {
    // @ts-expect-error Persistence owns a required database probe.
    persistence: () => ({}),
  },
  groups: {},
};
export const misplacedProbe: ApplicationFactories = {
  integrations: {
    // @ts-expect-error Only persistence can declare a database probe.
    messaging: () => ({
      database: { useFactory: () => () => Promise.resolve() },
    }),
  },
  groups: {},
};

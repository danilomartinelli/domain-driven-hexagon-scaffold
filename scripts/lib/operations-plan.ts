import type { ApplicationDeclaration } from '@starter/capabilities/declaration';
import {
  retainResources,
  sameHttps,
  type AppliedApplication,
  type Artifact,
  type DeploymentConfig,
  type InstallationState,
} from './operations-config';

/** A desired image after isolated inspection, with its packaged migrations in order. */
export interface PlannedArtifact extends Artifact {
  migrations: readonly string[];
}

type Https = NonNullable<DeploymentConfig['https']>;
type Activity = 'active' | 'inactive';
interface Capabilities {
  persistence: boolean;
  messaging: boolean;
  exposure: boolean;
  routes: string[];
}
type SelectedApplication = Capabilities & {
  application: string;
  image: string;
};
type ServiceRole = 'application' | 'database' | 'broker' | 'gateway';

export interface DeploymentPlan {
  installation: { name: string; project: string; status: 'new' | 'existing' };
  changed: boolean;
  /** Recorded outcomes are never inferred from a selected digest. */
  applied: {
    https: Https | null;
    applications: (SelectedApplication & {
      migration: NonNullable<AppliedApplication['migration']> | 'unrecorded';
      startup: NonNullable<AppliedApplication['startup']> | 'unrecorded';
    })[];
  };
  desired: { https: Https | null; applications: SelectedApplication[] };
  changes: {
    additions: SelectedApplication[];
    removals: { application: string; image: string }[];
    images: { application: string; from: string; to: string }[];
    capabilities: {
      application: string;
      from: Capabilities;
      to: Capabilities;
    }[];
    ingress: { from: Https | null; to: Https | null } | null;
  };
  services: {
    add: string[];
    stop: string[];
    recreate: string[];
    unchanged: string[];
  };
  resources: {
    retain: (
      | {
          kind: 'database';
          application: string;
          volume: string;
          before: Activity;
          after: Activity;
        }
      | { kind: 'broker'; volume: string; before: Activity; after: Activity }
    )[];
    provision: (
      | {
          kind: 'database';
          application: string;
          volume: string;
          database: string;
          roles: string[];
          secrets: string[];
        }
      | { kind: 'broker'; volume: string; vhost: string; secrets: string[] }
    )[];
    missingSecrets: string[];
  };
  migrations: {
    application: string;
    image: string;
    /** `unavailable` never claims an empty history: the database was not readable. */
    history: 'new-database' | 'read' | 'unavailable';
    applicable: string[] | null;
    unknownToImage: string[] | null;
  }[];
  interruptions: { service: string; effect: string }[];
}

const byName = (left: Artifact, right: Artifact) =>
  left.declaration.name.localeCompare(right.declaration.name);
const sorted = (values: Iterable<string>) =>
  [...values].sort((left, right) => left.localeCompare(right));

function capabilities({
  persistence,
  messaging,
  exposure,
  routes,
}: ApplicationDeclaration): Capabilities {
  return {
    persistence,
    messaging,
    exposure,
    routes: (routes ?? []).map((route) => route.name),
  };
}

/** The long-running Compose services each selection requires, by role. */
function services(applications: Iterable<Artifact>): Map<string, ServiceRole> {
  const roles = new Map<string, ServiceRole>();
  for (const { declaration } of applications) {
    roles.set(`app-${declaration.name}`, 'application');
    if (declaration.persistence)
      roles.set(`postgres-${declaration.name}`, 'database');
    if (declaration.messaging) roles.set('rabbitmq', 'broker');
    if (declaration.exposure) roles.set('gateway', 'gateway');
  }
  return roles;
}

const stopEffects: Record<ServiceRole, string> = {
  application:
    'Stopped; its routes and message consumption pause while its resources are retained',
  database:
    'Stopped; its database volume, identities and credentials are retained',
  broker: 'Stopped; queued and retained messages remain on its volume',
  gateway: 'Stopped; no business routes remain exposed',
};

/** Kong's declarative routes depend only on exposed declarations and HTTPS. */
function ingress(applications: Iterable<Artifact>, https?: Https): string {
  return JSON.stringify({
    https: https ?? null,
    routes: [...applications]
      .filter(({ declaration }) => declaration.exposure)
      .sort(byName)
      .map(({ declaration }) => [declaration.name, declaration.routes ?? []]),
  });
}

/**
 * Preview the transition from the applied installation to the desired selection.
 * This projection reads recorded state only; applying it is a separate operation.
 */
export function deploymentPlan(input: {
  state: InstallationState;
  existing: boolean;
  desired: { https?: Https; applications: readonly PlannedArtifact[] };
  /** Each retained database's applied migrations; undefined when unreadable now. */
  histories: Readonly<Record<string, readonly string[] | undefined>>;
  secretFiles: readonly string[];
}): DeploymentPlan {
  const { state, desired } = input;
  const applied = new Map(
    state.applied.applications.map((entry) => [entry.declaration.name, entry]),
  );
  const requested = new Map(
    desired.applications.map((entry) => [entry.declaration.name, entry]),
  );
  const transitions = [...requested.values()].sort(byName).flatMap((after) => {
    const before = applied.get(after.declaration.name);
    return before
      ? [
          {
            before,
            after,
            imageChanged: before.image !== after.image,
            declarationChanged:
              JSON.stringify(before.declaration) !==
              JSON.stringify(after.declaration),
          },
        ]
      : [];
  });
  const changes = {
    additions: [...requested.values()]
      .filter((entry) => !applied.has(entry.declaration.name))
      .sort(byName)
      .map((entry) => ({
        application: entry.declaration.name,
        image: entry.image,
        ...capabilities(entry.declaration),
      })),
    removals: [...applied.values()]
      .filter((entry) => !requested.has(entry.declaration.name))
      .sort(byName)
      .map((entry) => ({
        application: entry.declaration.name,
        image: entry.image,
      })),
    images: transitions
      .filter(({ imageChanged }) => imageChanged)
      .map(({ before, after }) => ({
        application: after.declaration.name,
        from: before.image,
        to: after.image,
      })),
    capabilities: transitions
      .filter(({ declarationChanged }) => declarationChanged)
      .map(({ before, after }) => ({
        application: after.declaration.name,
        from: capabilities(before.declaration),
        to: capabilities(after.declaration),
      })),
    ingress: sameHttps(state.applied.https, desired.https)
      ? null
      : { from: state.applied.https ?? null, to: desired.https ?? null },
  };

  const before = services(applied.values());
  const after = services(requested.values());
  const recreate = new Set(
    transitions
      .filter(
        ({ imageChanged, declarationChanged }) =>
          imageChanged || declarationChanged,
      )
      .map(({ after }) => `app-${after.declaration.name}`),
  );
  // Application updates recreate the active gateway even if its routes are unchanged.
  if (
    before.has('gateway') &&
    after.has('gateway') &&
    (recreate.size > 0 ||
      ingress(applied.values(), state.applied.https) !==
        ingress(requested.values(), desired.https))
  )
    recreate.add('gateway');
  const stop = sorted(
    [...before.keys()].filter((service) => !after.has(service)),
  );

  const activity = (
    selection: ReadonlyMap<string, Artifact>,
    active: (declaration: ApplicationDeclaration) => boolean,
  ): Activity =>
    [...selection.values()].some(({ declaration }) => active(declaration))
      ? 'active'
      : 'inactive';
  const usesDatabase =
    (application: string) => (declaration: ApplicationDeclaration) =>
      declaration.name === application && declaration.persistence;
  const usesBroker = (declaration: ApplicationDeclaration) =>
    declaration.messaging;
  const retainedDatabases = new Set(
    state.retained.databases.map((entry) => entry.application),
  );
  const retained = retainResources(state, desired.applications);
  const required = new Set<string>();
  for (const entry of retained.databases)
    if (activity(requested, usesDatabase(entry.application)) === 'active')
      for (const secret of entry.secrets) required.add(secret);
  if (retained.broker && activity(requested, usesBroker) === 'active')
    for (const secret of retained.broker.secrets) required.add(secret);
  if (after.has('gateway'))
    for (const secret of ['tls.crt', 'tls.key']) required.add(secret);

  const effects = new Map<string, string>();
  for (const { before, after } of transitions) {
    const service = `app-${after.declaration.name}`;
    if (!recreate.has(service)) continue;
    effects.set(
      service,
      before.declaration.persistence && after.declaration.persistence
        ? 'Stopped for a backup and its applicable owned migrations, then restarted'
        : after.declaration.persistence
          ? 'Stopped while its database is provisioned and migrated, then restarted'
          : 'Restarted with the requested image or capabilities',
    );
  }
  for (const service of stop) {
    const role = before.get(service);
    if (role) effects.set(service, stopEffects[role]);
  }
  if (recreate.has('gateway'))
    effects.set(
      'gateway',
      'Recreated; every exposed route is briefly unavailable',
    );

  return {
    installation: {
      name: state.name,
      project: state.project,
      status: input.existing ? 'existing' : 'new',
    },
    changed: Boolean(
      changes.additions.length ||
      changes.removals.length ||
      changes.images.length ||
      changes.capabilities.length ||
      changes.ingress,
    ),
    applied: {
      https: state.applied.https ?? null,
      applications: [...applied.values()].sort(byName).map((entry) => ({
        application: entry.declaration.name,
        image: entry.image,
        ...capabilities(entry.declaration),
        migration: entry.migration ?? 'unrecorded',
        startup: entry.startup ?? 'unrecorded',
      })),
    },
    desired: {
      https: desired.https ?? null,
      applications: [...requested.values()].sort(byName).map((entry) => ({
        application: entry.declaration.name,
        image: entry.image,
        ...capabilities(entry.declaration),
      })),
    },
    changes,
    services: {
      add: sorted([...after.keys()].filter((service) => !before.has(service))),
      stop,
      recreate: sorted(recreate),
      unchanged: sorted(
        [...before.keys()].filter(
          (service) => after.has(service) && !recreate.has(service),
        ),
      ),
    },
    resources: {
      retain: [
        ...state.retained.databases.map((entry) => ({
          kind: 'database' as const,
          application: entry.application,
          volume: entry.volume,
          before: activity(applied, usesDatabase(entry.application)),
          after: activity(requested, usesDatabase(entry.application)),
        })),
        ...(state.retained.broker
          ? [
              {
                kind: 'broker' as const,
                volume: state.retained.broker.volume,
                before: activity(applied, usesBroker),
                after: activity(requested, usesBroker),
              },
            ]
          : []),
      ],
      provision: [
        ...retained.databases
          .filter((entry) => !retainedDatabases.has(entry.application))
          .map((entry) => ({
            kind: 'database' as const,
            application: entry.application,
            volume: entry.volume,
            database: entry.database,
            roles: entry.roles,
            secrets: entry.secrets,
          })),
        ...(retained.broker && !state.retained.broker
          ? [
              {
                kind: 'broker' as const,
                volume: retained.broker.volume,
                vhost: retained.broker.vhost,
                secrets: retained.broker.secrets,
              },
            ]
          : []),
      ],
      missingSecrets: sorted(
        [...required].filter((secret) => !input.secretFiles.includes(secret)),
      ),
    },
    migrations: [...requested.values()]
      .filter(({ declaration }) => declaration.persistence)
      .sort(byName)
      .map(({ declaration, image, migrations }) => {
        if (!retainedDatabases.has(declaration.name))
          return {
            application: declaration.name,
            image,
            history: 'new-database' as const,
            applicable: [...migrations],
            unknownToImage: [],
          };
        const history = input.histories[declaration.name];
        return history
          ? {
              application: declaration.name,
              image,
              history: 'read' as const,
              applicable: migrations.filter((name) => !history.includes(name)),
              unknownToImage: history.filter(
                (name) => !migrations.includes(name),
              ),
            }
          : {
              application: declaration.name,
              image,
              history: 'unavailable' as const,
              applicable: null,
              unknownToImage: null,
            };
      }),
    interruptions: [...effects]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([service, effect]) => ({ service, effect })),
  };
}

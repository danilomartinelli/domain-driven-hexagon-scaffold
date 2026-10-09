import type { Artifact } from './operations-config';
import type { ApplicationRuntime } from './operations-verification';

/** Actions can fail after effects. Only independent observations establish runtime readiness. */
export interface InstallationRuntime {
  startDatabase: (application: string) => Promise<void>;
  provisionDatabase: (application: string) => Promise<void>;
  startBroker: () => Promise<void>;
  verifyBroker: (target: Artifact) => Promise<void>;
  inspectMigrations: (
    target: Artifact,
  ) => Promise<{ evidence: string; unknown: string[] }>;
  migrate: (target: Artifact) => Promise<void>;
  stopApplication: (application: string) => Promise<void>;
  backup: (target: Artifact, path: string) => Promise<string>;
  startCandidate: (target: Artifact) => Promise<void>;
  refreshGateway: () => Promise<void>;
  /** Cleanup observations remain available after cancellation. */
  observeCandidate: (
    target: Artifact,
    cleanup?: boolean,
  ) => Promise<ApplicationRuntime>;
  /** Both cleanup actions must remain available after cancellation. */
  collectCandidateDiagnostics: (application: string) => Promise<void>;
  stopFailedCandidate: (application: string) => Promise<void>;
}

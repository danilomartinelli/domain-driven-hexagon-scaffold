import { join } from 'node:path';
import { withCleanup } from './cleanup';
import { backupApplication } from './operations-backup';
import {
  readJson,
  writeJson,
  retainResources,
  type Artifact,
  type AppliedApplication,
  type InstallationState,
} from './operations-config';
import {
  transitionSchema,
  unverified,
  type Transition,
} from './operations-transition';
import {
  probeApplication,
  waitForCandidate,
  type ApplicationRuntime,
} from './operations-verification';
import {
  provisionApplication,
  verifyBrokerAccess,
  refreshOperationsGateway,
  type OperationsCommand,
  type OneShot,
} from './operations-services';

export interface CompatibilityReview {
  application: string;
  currentImage: string;
  targetImage: string;
  migrationHistory: string[];
  schemaReview: string;
  eventContractReview: string;
}
export type PromotionRequest = { id: string; candidate: Artifact } & (
  | {
      kind: 'apply';
      deployment: string;
      /** Link the durable Transition to its caller-owned deployment step before effects begin. */
      recordAttempt: (transitionId: string) => void;
    }
  | { kind: 'update' }
  | { kind: 'rollback'; compatibilityReview: CompatibilityReview }
);
export class IncompletePromotion extends Error {
  constructor(
    message: string,
    readonly status:
      'failed' | 'interrupted' | 'verification-pending' | 'verification-failed',
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'IncompletePromotion';
  }
}
/** One definition for planning and update preflight. */
export function unknownMigrations(
  history: readonly string[],
  packaged: readonly string[],
): string[] {
  const known = new Set(packaged);
  return history.filter((name) => !known.has(name));
}
export const olderImageError = (
  application: string,
  migrations: readonly string[],
): Error =>
  new Error(
    `${application}: its database already applied migrations unknown to the selected image (${migrations.join(', ')}); return to an older image only through the compatibility-reviewed rollback command`,
  );
export const incompleteVerificationError = (application: string): Error =>
  new Error(
    `Continue or roll back ${application} before further promotions; verification is incomplete`,
  );
export function pendingCandidate(
  state: InstallationState,
  application: string,
): string | undefined {
  return state.pendingTransitions?.[application];
}

/** The only writer of Transitions and pending Candidates, using the existing operator primitives. */
export function operationsPromotion({
  store,
  compose,
  execute,
  oneShot,
  signal,
  diagnostics,
}: {
  store: {
    current: InstallationState;
    save: () => void;
    saveCompose: (state?: InstallationState) => void;
  };
  compose: OperationsCommand;
  execute: OperationsCommand;
  oneShot: OneShot;
  signal: AbortSignal;
  diagnostics: { logPath: string };
}): {
  promote: (request: PromotionRequest) => Promise<void>;
  continue: (selected: Artifact, id?: string) => Promise<boolean>;
  withdraw: (application: string) => void;
} {
  const current = store.current;
  const directory = current.directory;
  const transitionPath = (id: string) =>
    join(directory, `transition-${id}.json`);
  const now = () => new Date().toISOString();
  const failure = () =>
    signal.aborted ? ('interrupted' as const) : ('failed' as const);
  const clearPendingCandidate = (application: string) => {
    const remaining = Object.entries(current.pendingTransitions ?? {}).filter(
      ([name]) => name !== application,
    );
    if (remaining.length)
      current.pendingTransitions = Object.fromEntries(remaining);
    else delete current.pendingTransitions;
    store.save();
  };
  const recordOutcome = (
    application: string,
    outcome: Partial<Pick<AppliedApplication, 'migration' | 'startup'>>,
  ) => {
    const entry = current.applied.applications.find(
      (candidate) => candidate.declaration.name === application,
    );
    if (entry) Object.assign(entry, outcome);
    store.save();
  };
  const migrate = (target: Artifact, command: 'up' | 'status') =>
    oneShot(`migrate-${target.declaration.name}`, [
      'run',
      `migration:${command}`,
    ]);
  const provision = (application: string) =>
    provisionApplication(compose, application);
  const verifyBroker = (target: Artifact) =>
    verifyBrokerAccess(oneShot, target);
  const refreshGateway = () => refreshOperationsGateway(current, compose);
  const verifyCandidate = async (
    selected: Artifact,
    record: Transition,
    recordPath: string,
  ) => {
    record.status = 'verifying';
    record.verification = { outcome: 'pending', reason: 'readiness' };
    writeJson(recordPath, record);
    recordOutcome(selected.declaration.name, {
      startup: {
        operation: record.action,
        image: selected.image,
        readiness: 'full',
        result: 'pending',
        at: now(),
      },
    });
    let observed: ApplicationRuntime | null = null;
    try {
      const before = await probeApplication(selected, compose, execute);
      if (before.process !== 'running' || before.image !== selected.image) {
        try {
          await compose([
            'up',
            '-d',
            '--no-deps',
            `app-${selected.declaration.name}`,
          ]);
        } catch {
          // Docker may create a container before its client fails. Observe the
          // candidate through the same deadline before deciding whether to stop it.
          record.error = `Candidate startup command failed; inspect ${diagnostics.logPath}`;
        }
      }
      // Load ingress before the final readiness observation, including when
      // messaging remains degraded. A gateway failure must not skip candidate checks.
      let gatewayReady = true;
      try {
        await refreshGateway();
      } catch {
        gatewayReady = false;
      }
      const runtime = await waitForCandidate(
        selected,
        compose,
        execute,
        (runtime) => {
          observed = runtime;
          record.runtime = runtime;
          writeJson(recordPath, record);
        },
        signal,
      );
      if (runtime.process !== 'running' || runtime.http === 'not_ready') {
        record.status = 'verification-failed';
        record.verification = {
          outcome: 'failed',
          reason:
            runtime.process !== 'running' ? 'process-failed' : 'http-failed',
        };
        // The application owns its 15-second shutdown; Compose grants 20 seconds.
        await withCleanup(
          () =>
            compose(
              [
                'logs',
                '--no-color',
                '--tail',
                '200',
                `app-${selected.declaration.name}`,
              ],
              15_000,
              true,
            ),
          [
            () =>
              compose(
                ['stop', '--timeout', '20', `app-${selected.declaration.name}`],
                30_000,
                true,
              ),
          ],
        );
        record.runtime = await probeApplication(
          selected,
          compose,
          execute,
          true,
        );
        throw new Error(
          `Candidate stopped after verification deadline. Continue or roll back explicitly. Diagnostic: ${diagnostics.logPath}`,
        );
      }
      if (runtime.http !== 'ready') {
        record.verification.reason = 'http-unknown';
        throw new Error(
          `Candidate verification pending: HTTP probe unavailable. Continue or roll back explicitly. Diagnostic: ${diagnostics.logPath}`,
        );
      }
      if (!gatewayReady) {
        record.verification.reason = 'gateway';
        throw new Error(
          `Candidate verification pending: gateway unavailable. Diagnostic: ${diagnostics.logPath}`,
        );
      }
      if (!['ready', 'not_applicable'].includes(runtime.messaging)) {
        record.status = 'verification-pending';
        record.verification = {
          outcome: 'pending',
          reason: 'messaging-degraded',
        };
        throw new Error(
          `Candidate HTTP remains available; messaging verification pending. Continue or roll back explicitly. Diagnostic: ${diagnostics.logPath}`,
        );
      }
      record.status = 'verified';
      record.verification = { outcome: 'verified', reason: '' };
      record.error = '';
      writeJson(recordPath, record);
      clearPendingCandidate(selected.declaration.name);
      console.log(
        `Transition verified: ${selected.declaration.name} ${selected.image}`,
      );
    } catch (error) {
      if (record.status === 'verifying') {
        record.status = 'verification-pending';
        record.verification = {
          outcome: 'pending',
          reason: signal.aborted ? 'interrupted' : record.verification.reason,
        };
      }
      if (signal.aborted) record.status = 'interrupted';
      throw new IncompletePromotion(
        error instanceof Error
          ? error.message
          : 'Candidate verification incomplete',
        signal.aborted
          ? 'interrupted'
          : record.status === 'verification-failed'
            ? 'verification-failed'
            : 'verification-pending',
        { cause: error },
      );
    } finally {
      recordOutcome(selected.declaration.name, {
        startup: {
          operation: record.action,
          image: selected.image,
          readiness: 'full',
          result: signal.aborted
            ? 'interrupted'
            : record.verification.outcome === 'verified'
              ? 'verified'
              : record.verification.outcome === 'failed'
                ? 'failed'
                : 'pending',
          at: now(),
        },
      });
      record.attempts.push({
        diagnostic: diagnostics.logPath,
        runtime: observed,
        ...record.verification,
      });
      writeJson(recordPath, record);
    }
  };
  const promote = async (request: PromotionRequest): Promise<void> => {
    const { id, candidate: target, kind } = request;
    const application = target.declaration.name;
    const previous = current.applied.applications.find(
      (entry) => entry.declaration.name === application,
    );
    if (pendingCandidate(current, application) && kind !== 'rollback')
      throw incompleteVerificationError(application);
    const recordPath = transitionPath(id);
    const record: Transition = {
      action: kind,
      application,
      previousImage: previous?.image ?? null,
      candidateImage: target.image,
      compatibilityReview:
        request.kind === 'rollback' ? request.compatibilityReview : null,
      status: 'preparing',
      migrationStatus: '',
      migration: {
        outcome: target.declaration.persistence
          ? 'not-started'
          : 'not-applicable',
        completedAt: null,
      },
      runtime: null,
      verification: { outcome: 'not-started', reason: '' },
      attempts: [],
      backup: '',
      error: '',
      diagnostic: diagnostics.logPath,
      ...(request.kind === 'apply' ? { deployment: request.deployment } : {}),
    };
    writeJson(recordPath, record);
    if (request.kind === 'apply') request.recordAttempt(id);
    let migration: AppliedApplication['migration'];
    const promoted = (): AppliedApplication[] => {
      const entry: AppliedApplication = {
        ...previous,
        ...target,
        ...(migration ? { migration } : {}),
      };
      return previous
        ? current.applied.applications.map((candidate) =>
            candidate === previous ? entry : candidate,
          )
        : [...current.applied.applications, entry];
    };
    const databaseExisted = current.retained.databases.some(
      (entry) => entry.application === application,
    );
    const brokerActive = current.applied.applications.some(
      (entry) => entry.declaration.messaging,
    );
    await withCleanup(async () => {
      try {
        // Identities are recorded before their volumes exist, so a later
        // failure cannot strand inspection, shutdown or reactivation.
        if (kind === 'apply')
          current.retained = retainResources(current, [target]);
        store.save();
        store.saveCompose({
          ...current,
          applied: { ...current.applied, applications: promoted() },
        });
        if (kind === 'apply' && target.declaration.persistence) {
          await compose([
            'up',
            '-d',
            '--wait',
            '--wait-timeout',
            '60',
            `postgres-${application}`,
          ]);
          if (!previous?.declaration.persistence) await provision(application);
        }
        if (kind === 'apply' && target.declaration.messaging) {
          await compose([
            'up',
            '-d',
            '--wait',
            '--wait-timeout',
            '60',
            'rabbitmq',
          ]);
          if (!brokerActive) await verifyBroker(target);
        }
        if (target.declaration.persistence) {
          record.migrationStatus = await migrate(target, 'status');
          const unknown = [
            ...record.migrationStatus.matchAll(/^missing file\t(.+)$/gm),
          ].map(([, migration]) => migration);
          if (kind !== 'rollback' && unknown.length)
            throw olderImageError(application, unknown);
        }
        if (previous)
          await compose(['stop', '--timeout', '20', `app-${application}`]);
        if (target.declaration.persistence) {
          if (databaseExisted)
            record.backup = await backupApplication(
              current,
              previous?.declaration.persistence ? previous : target,
              join(directory, 'backups', `${application}-${id}.dump`),
              compose,
            );
          if (kind === 'rollback') {
            record.status = 'compatibility-reviewed';
            record.migration.outcome = 'compatibility-reviewed';
            writeJson(recordPath, record);
          } else {
            record.status = 'migrating';
            record.migration.outcome = 'running';
            writeJson(recordPath, record);
            try {
              await migrate(target, 'up');
            } catch (error) {
              record.migration.outcome = failure();
              recordOutcome(application, {
                migration: {
                  operation: kind,
                  image: target.image,
                  result: failure(),
                  at: now(),
                },
              });
              throw error;
            }
            record.migration = { outcome: 'completed', completedAt: now() };
            migration = {
              operation: kind,
              image: target.image,
              result: 'committed',
              at: record.migration.completedAt ?? now(),
            };
            recordOutcome(application, { migration });
          }
        }
        record.status = 'promoting';
        writeJson(recordPath, record);
        current.applied.applications = promoted();
        current.pendingTransitions ??= {};
        current.pendingTransitions[application] = id;
        store.save();
        await verifyCandidate(target, record, recordPath);
      } catch (error) {
        if (signal.aborted) {
          record.status = 'interrupted';
          if (
            target.declaration.persistence &&
            record.verification.outcome === 'not-started' &&
            record.migration.completedAt === null
          ) {
            record.migration.outcome = 'interrupted';
            recordOutcome(application, {
              migration: {
                operation: kind,
                image: target.image,
                result: 'interrupted',
                at: now(),
              },
            });
          }
        } else if (!unverified(record.status)) record.status = 'failed';
        record.error =
          'No automatic database reversal. Inspect status and retained transition evidence before recovery.';
        throw new IncompletePromotion(
          error instanceof Error ? error.message : 'Promotion incomplete',
          signal.aborted
            ? 'interrupted'
            : unverified(record.status)
              ? record.status
              : 'failed',
          { cause: error },
        );
      }
    }, [
      () => {
        writeJson(recordPath, record);
      },
      () => {
        store.saveCompose();
      },
    ]);
  };
  return {
    promote,
    continue: async (
      selected: Artifact,
      id = pendingCandidate(current, selected.declaration.name),
    ): Promise<boolean> => {
      const pending = pendingCandidate(current, selected.declaration.name);
      if (pending && pending !== id)
        throw incompleteVerificationError(selected.declaration.name);
      if (!id) return false;
      const path = transitionPath(id);
      const record = transitionSchema.parse(readJson(path));
      const applied = current.applied.applications.find(
        (entry) => entry.declaration.name === selected.declaration.name,
      );
      if (
        record.application !== selected.declaration.name ||
        applied?.image !== selected.image ||
        record.candidateImage !== selected.image ||
        !['completed', 'not-applicable', 'compatibility-reviewed'].includes(
          record.migration.outcome,
        )
      )
        return false;
      if (record.status !== 'verified' || pending === id)
        await verifyCandidate(selected, record, path);
      return true;
    },
    withdraw: (application: string): void => {
      const id = pendingCandidate(current, application);
      if (!id) return;
      const path = transitionPath(id);
      const record = transitionSchema.parse(readJson(path));
      record.status = 'withdrawn';
      record.error =
        'Removed by a reviewed topology deployment; durable state retained.';
      writeJson(path, record);
      clearPendingCandidate(application);
    },
  };
}

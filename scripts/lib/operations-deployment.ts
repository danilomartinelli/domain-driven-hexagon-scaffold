import { z } from 'zod';
import { httpsSchema, imageDigest } from './operations-config';
import type { DeploymentPlan } from './operations-plan';

const timestamp = z.iso.datetime();
const selection = z.strictObject({
  https: httpsSchema.nullable(),
  images: z.record(z.string(), imageDigest),
});
const stepStatus = z.enum([
  'not-started',
  'running',
  'completed',
  'failed',
  'interrupted',
  'verification-pending',
  'verification-failed',
]);
const stepSchema = z.strictObject({
  /**
   * `ingress` selects a new HTTPS listener, `remove` retires an application,
   * `promote` provisions, migrates and verifies an added or changed one, and
   * `reconcile` stops infrastructure the applied selection no longer needs.
   */
  kind: z.enum(['ingress', 'remove', 'promote', 'reconcile']),
  application: z.string().nullable(),
  from: imageDigest.nullable(),
  to: imageDigest.nullable(),
  status: stepStatus,
  /** Every promotion attempt's transition record, oldest first. */
  transitions: z.array(z.uuid()),
  completedAt: timestamp.nullable(),
});
export type DeploymentStep = z.infer<typeof stepSchema>;

/** Durable per-application progress of one explicitly applied topology plan. */
export const deploymentRecordSchema = z.strictObject({
  id: z.uuid(),
  status: z.enum(['applying', 'incomplete', 'completed', 'superseded']),
  createdAt: timestamp,
  /** The reviewed desired selection; continuation requires it to remain selected. */
  desired: selection,
  /** The applied selection the deployment started from, as operator evidence. */
  baseline: selection,
  steps: z.array(stepSchema),
  /** Pending ingress reload survives failed reconciliation and operator restarts. */
  gatewayReloadPending: z.boolean().optional(),
  attempts: z.array(
    z.strictObject({
      operation: z.enum(['apply', 'continue']),
      at: timestamp,
      diagnostic: z.string(),
      outcome: z.enum(['running', 'completed', 'incomplete', 'interrupted']),
      error: z.string(),
    }),
  ),
  supersededBy: z.uuid().nullable(),
});
export type DeploymentRecord = z.infer<typeof deploymentRecordSchema>;

/** Read the durable reload obligation, including progress from older records. */
export function requiresGatewayReload(record: DeploymentRecord): boolean {
  if (record.gatewayReloadPending !== undefined)
    return record.gatewayReloadPending;
  // Removed declarations are no longer applied, so older records require a
  // conservative reload after removals until a later promotion confirms it.
  let pending = false;
  for (const step of record.steps) {
    if (step.status === 'not-started') continue;
    if (step.kind === 'ingress' || step.kind === 'remove') pending = true;
    else if (step.kind === 'promote' && step.status === 'completed')
      pending = false;
  }
  return pending;
}

/**
 * Order a reviewed plan: a new ingress first, then removals, then one promotion
 * per added or changed application in name order, then infrastructure
 * reconciliation. A failed promotion stops every later step.
 */
export function deploymentSteps(plan: DeploymentPlan): DeploymentStep[] {
  const step = (
    kind: DeploymentStep['kind'],
    application: string | null,
    from: string | null,
    to: string | null,
  ): DeploymentStep => ({
    kind,
    application,
    from,
    to,
    status: 'not-started',
    transitions: [],
    completedAt: null,
  });
  const applied = new Map(
    plan.applied.applications.map((entry) => [entry.application, entry.image]),
  );
  const desired = new Map(
    plan.desired.applications.map((entry) => [entry.application, entry.image]),
  );
  const promoted = new Set([
    ...plan.changes.additions.map(({ application }) => application),
    ...plan.changes.images.map(({ application }) => application),
    ...plan.changes.capabilities.map(({ application }) => application),
  ]);
  return [
    ...(plan.changes.ingress?.to ? [step('ingress', null, null, null)] : []),
    ...plan.changes.removals.map(({ application, image }) =>
      step('remove', application, image, null),
    ),
    ...[...promoted]
      .sort((left, right) => left.localeCompare(right))
      .map((application) =>
        step(
          'promote',
          application,
          applied.get(application) ?? null,
          desired.get(application) ?? null,
        ),
      ),
    step('reconcile', null, null, null),
  ];
}

/** One line per step, so a partial outcome names completed and remaining work. */
export function deploymentSummary(record: DeploymentRecord): string {
  return record.steps
    .map(
      ({ kind, application, status }) =>
        `- ${kind}${application ? ` ${application}` : ''}: ${status}`,
    )
    .join('\n');
}

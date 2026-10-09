import { z } from 'zod';
import type { ApplicationDeclaration } from './declaration';

const status = z.object({ status: z.enum(['ready', 'not_ready']) });
const notApplicable = z.strictObject({ status: z.literal('not_applicable') });
const role = z.union([
  notApplicable,
  z
    .object({
      status: z.enum(['ready', 'not_ready']),
      connected: z.boolean(),
      failures: z.number().int().nonnegative(),
      retries: z.number().int().nonnegative(),
      retryDelayMs: z.number().nonnegative(),
      lastFailureAt: z.string().nullable(),
      reason: z.string().nullable(),
    })
    .refine(
      (value) =>
        value.status !== 'ready' || (value.connected && value.reason === null),
      'A ready messaging role must be connected and have no reason',
    ),
]);
const snapshotSchema = z.object({
  service: z.string(),
  lifecycle: z.enum(['running', 'draining', 'stopping']),
  http: status,
  database: z.union([status, notApplicable]),
  consumer: role,
  publisher: role,
});
const httpSchema = z.object({
  service: z.string(),
  status: z.enum(['ready', 'not_ready']),
});

export type ReadinessSnapshot = z.infer<typeof snapshotSchema>;
export type HttpReadiness = z.infer<typeof httpSchema>;
export type ReadinessResult<T> =
  { valid: true; snapshot: T } | { valid: false; reason: string };

/** Validate the report's shape and applicability; readiness policy belongs to callers. */
export function parseReadinessSnapshot(
  value: unknown,
  declaration: ApplicationDeclaration,
): ReadinessResult<ReadinessSnapshot> {
  const parsed = snapshotSchema.safeParse(value);
  if (!parsed.success)
    return { valid: false, reason: z.prettifyError(parsed.error) };
  const snapshot = parsed.data;
  if (snapshot.service !== declaration.name)
    return {
      valid: false,
      reason: 'Readiness service does not match the declaration',
    };
  if (
    (snapshot.database.status !== 'not_applicable') !==
    declaration.persistence
  )
    return {
      valid: false,
      reason: 'Persistence capability does not match database applicability',
    };
  const applicable = [snapshot.consumer, snapshot.publisher].some(
    (entry) => entry.status !== 'not_applicable',
  );
  if (applicable !== declaration.messaging)
    return {
      valid: false,
      reason:
        'Messaging capability does not match consumer/publisher applicability',
    };
  return { valid: true, snapshot };
}

/** The private HTTP response uses the same service identity and readiness statuses. */
export function parseHttpReadiness(
  value: unknown,
  declaration: ApplicationDeclaration,
): ReadinessResult<HttpReadiness> {
  const parsed = httpSchema.safeParse(value);
  if (!parsed.success)
    return { valid: false, reason: z.prettifyError(parsed.error) };
  if (parsed.data.service !== declaration.name)
    return {
      valid: false,
      reason: 'Readiness service does not match the declaration',
    };
  return { valid: true, snapshot: parsed.data };
}

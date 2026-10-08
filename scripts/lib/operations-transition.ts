import { z } from 'zod';
import { imageDigest } from './operations-config';
import { runtimeSchema } from './operations-verification';

/** Durable progress is independent of image selection and the latest runtime observation. */
export const transitionSchema = z.object({
  action: z.enum(['update', 'rollback', 'apply']),
  application: z.string(),
  // Applied additions have no previous image.
  previousImage: imageDigest.nullable(),
  candidateImage: imageDigest,
  compatibilityReview: z.unknown(),
  status: z.string(),
  migrationStatus: z.string(),
  migration: z.object({
    outcome: z.enum([
      'not-started',
      'running',
      'completed',
      'failed',
      'interrupted',
      'not-applicable',
      'compatibility-reviewed',
    ]),
    completedAt: z.string().nullable(),
  }),
  runtime: runtimeSchema.nullable(),
  verification: z.object({
    outcome: z.enum(['not-started', 'pending', 'failed', 'verified']),
    reason: z.string(),
  }),
  attempts: z.array(
    z.object({
      diagnostic: z.string(),
      runtime: runtimeSchema.nullable(),
      outcome: z.string(),
      reason: z.string(),
    }),
  ),
  backup: z.string(),
  error: z.string(),
  diagnostic: z.string(),
  /** The topology deployment that requested an applied transition. */
  deployment: z.uuid().optional(),
});
export type Transition = z.infer<typeof transitionSchema>;

/** A promoted candidate whose verification has not succeeded. */
export function unverified(
  status: string,
): status is 'verification-pending' | 'verification-failed' {
  return status === 'verification-pending' || status === 'verification-failed';
}

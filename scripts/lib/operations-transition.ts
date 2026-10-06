import { z } from 'zod';
import { imageDigest } from './operations-config';
import { runtimeSchema } from './operations-verification';

/** Durable progress is independent of image selection and the latest runtime observation. */
export const transitionSchema = z.object({
  action: z.enum(['update', 'rollback']),
  application: z.string(),
  previousImage: imageDigest,
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
});
export type Transition = z.infer<typeof transitionSchema>;

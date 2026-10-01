import { z } from 'zod';

/** User owns this wire contract; it contains no domain classes or profile data. */
const identity = z
  .string()
  .min(1)
  .max(255)
  .regex(/\S/)
  .refine(
    // NUL is not persistable; lone surrogates change identity when encoded as UTF-8.
    (value) => !value.includes('\0') && !/\p{Surrogate}/u.test(value),
  );
const occurredAt = z.iso.datetime({ offset: true }).refine(
  // PostgreSQL has no year zero and supports timezone displacement below 16 hours.
  (value) =>
    !value.startsWith('0000-') &&
    (value.endsWith('Z') || Number(value.slice(-5, -3)) < 16),
);
const envelope = z.object({
  type: z.literal('user.created'),
  version: z.literal(1),
  source: z.literal('user'),
  eventId: identity,
  occurredAt,
  correlationId: identity,
  causationId: identity,
  data: z.object({ userId: identity }),
});

export type UserCreatedEvent = z.infer<typeof envelope>;

/** Request metadata may be reused on the wire only when it fits the identity contract. */
export function isUserCreatedIdentity(value: unknown): value is string {
  return identity.safeParse(value).success;
}

export type UserCreatedDelivery =
  | { accepted: true; event: UserCreatedEvent }
  | { accepted: false; reason: 'invalid-or-unsupported-user-created' };

/** Unknown optional fields are ignored. Unsupported semantics require a new version. */
export function decodeUserCreatedEvent(
  body: string | Uint8Array,
): UserCreatedDelivery {
  let value: unknown;
  try {
    const text =
      typeof body === 'string'
        ? body
        : new TextDecoder('utf-8', { fatal: true }).decode(body);
    value = JSON.parse(text);
  } catch {
    return { accepted: false, reason: 'invalid-or-unsupported-user-created' };
  }
  const parsed = envelope.safeParse(value);
  return parsed.success
    ? { accepted: true, event: parsed.data }
    : { accepted: false, reason: 'invalid-or-unsupported-user-created' };
}

/** Direct routing, deliberately distinct from the User `user.create` command. */
export const userCreatedDestination = {
  exchange: 'user.events',
  routingKey: 'user.created.v1',
  walletQueue: 'wallet.user-created',
  walletFailureQueue: 'wallet.user-created.failed',
} as const;

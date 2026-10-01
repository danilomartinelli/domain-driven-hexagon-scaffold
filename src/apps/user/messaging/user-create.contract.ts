import { isEmail } from 'class-validator';
import { z } from 'zod';
import { isUserCreatedIdentity } from '@starter/integration-contracts/user-created';

const identity = z
  .string()
  .refine(isUserCreatedIdentity)
  .refine((value) => new TextEncoder().encode(value).byteLength <= 255);
const envelope = z.object({
  type: z.literal('user.create'),
  version: z.literal(1),
  commandId: identity,
  correlationId: identity,
  data: z.object({
    email: z.string().min(5).max(320).refine(isEmail),
    country: z
      .string()
      .min(4)
      .max(50)
      .regex(/^[a-zA-Z ]*$/),
    street: z
      .string()
      .min(5)
      .max(50)
      .regex(/^[a-zA-Z ]*$/),
    postalCode: z
      .string()
      .min(4)
      .max(10)
      .regex(/^[a-zA-Z0-9]+$/),
  }),
});

export type UserCreateCommand = z.infer<typeof envelope>;
export type UserCreateDelivery =
  | { accepted: true; command: UserCreateCommand }
  | { accepted: false; reason: 'invalid-or-unsupported-user-create' };

/** Framework-free wire validation; unknown additive fields never enter the use case. */
export function decodeUserCreateCommand(
  body: string | Uint8Array,
): UserCreateDelivery {
  try {
    const value: unknown = JSON.parse(
      typeof body === 'string'
        ? body
        : new TextDecoder('utf-8', { fatal: true }).decode(body),
    );
    const parsed = envelope.safeParse(value);
    if (parsed.success) return { accepted: true, command: parsed.data };
  } catch {
    // Malformed JSON and invalid UTF-8 follow the same retained failure path.
  }
  return { accepted: false, reason: 'invalid-or-unsupported-user-create' };
}

/** The live endpoint and operator replay apply the same wire/property checks. */
export function decodeUserCreateDelivery(
  body: string | Uint8Array,
  properties: {
    replyTo?: unknown;
    messageId?: unknown;
    correlationId?: unknown;
  },
):
  | { accepted: true; command: UserCreateCommand; replyTo: string }
  | {
      accepted: false;
      reason:
        'invalid-or-unsupported-user-create' | 'invalid-command-properties';
    } {
  const decoded = decodeUserCreateCommand(body);
  if (!decoded.accepted) return decoded;
  const { replyTo, messageId, correlationId } = properties;
  if (
    typeof replyTo !== 'string' ||
    !replyTo ||
    replyTo.startsWith('amq.rabbitmq.reply-to') ||
    messageId !== decoded.command.commandId ||
    correlationId !== decoded.command.correlationId
  )
    return { accepted: false, reason: 'invalid-command-properties' };
  return { ...decoded, replyTo };
}

export const userCreateDestination = {
  exchange: 'user.commands',
  routingKey: 'user.create',
  queue: 'user.create',
  failureQueue: 'user.create.failed',
} as const;

export type UserCreateResponse = {
  type: 'user.create.result';
  version: 1;
  commandId: string;
  correlationId: string;
} & ({ result: { id: string } } | { error: { code: string; message: string } });

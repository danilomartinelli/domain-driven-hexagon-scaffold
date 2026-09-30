import { randomUUID } from 'node:crypto';
import {
  decodeUserCreatedEvent,
  type UserCreatedDelivery,
} from '@starter/integration-contracts/user-created';
import type { CreateWallet } from '../application/create-wallet';

/** A fresh explicit message context; no HTTP middleware or ambient request state. */
export async function handleUserCreated(
  body: string | Uint8Array,
  create: CreateWallet,
): Promise<UserCreatedDelivery> {
  const delivery = decodeUserCreatedEvent(body);
  if (!delivery.accepted) return delivery;
  const { event } = delivery;
  await create.execute(
    {
      eventId: event.eventId,
      userId: event.data.userId,
      correlationId: event.correlationId,
      causationId: event.causationId,
      occurredAt: event.occurredAt,
    },
    { id: randomUUID(), createdAt: new Date() },
  );
  return delivery;
}

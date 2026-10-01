import type { UserCreatedEvent } from '@starter/integration-contracts/user-created';
import type { PendingUserCreated } from '../application/user-write.port';

/** Encode once on insertion; later publishers reuse the persisted envelope. */
export function userCreatedIntegrationEvent(
  pending: PendingUserCreated,
): UserCreatedEvent {
  const { userId, ...metadata } = pending;
  return {
    type: 'user.created',
    version: 1,
    source: 'user',
    ...metadata,
    data: { userId },
  };
}

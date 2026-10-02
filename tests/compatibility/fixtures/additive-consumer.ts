import {
  decodeUserCreatedEvent as baseline,
  type UserCreatedEvent,
  type UserCreatedDelivery,
} from './baseline-consumer';

export {
  isUserCreatedIdentity,
  userCreatedDestination,
} from './baseline-consumer';

// Fixed compatible consumer candidate. Optional tracing never changes the fact.
export function decodeUserCreatedEvent(body: string | Uint8Array):
  | UserCreatedDelivery
  | {
      accepted: true;
      event: UserCreatedEvent & { traceparent: string | undefined };
    } {
  const delivery = baseline(body);
  if (!delivery.accepted) return delivery;
  const value: unknown = JSON.parse(
    typeof body === 'string' ? body : new TextDecoder().decode(body),
  );
  const traceparent =
    typeof value === 'object' &&
    value !== null &&
    'traceparent' in value &&
    typeof value.traceparent === 'string'
      ? value.traceparent
      : undefined;
  return { ...delivery, event: { ...delivery.event, traceparent } };
}

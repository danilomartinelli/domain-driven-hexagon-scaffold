import { DomainEvent, type DomainEventProps } from '@libs/ddd';

export class WalletCreatedDomainEvent extends DomainEvent {
  // This example does not populate userId; completing events is outside this slice.
  readonly userId?: string;

  // eslint-disable-next-line @typescript-eslint/no-useless-constructor -- Preserve the event-specific constructor contract.
  constructor(props: DomainEventProps<WalletCreatedDomainEvent>) {
    super(props);
  }
}

import { DomainEvent, type DomainEventProps } from '@libs/ddd';

export class WalletCreatedDomainEvent extends DomainEvent {
  readonly userId: string;

  constructor(props: DomainEventProps<WalletCreatedDomainEvent>) {
    super(props);
  }
}

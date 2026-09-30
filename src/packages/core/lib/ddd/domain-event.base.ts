import { ArgumentNotProvidedException } from '../exceptions/index';
import { Guard } from '../guard';

export type DomainEventProps<T> = Omit<T, 'aggregateId'> & {
  aggregateId: string;
};

/** A recorded domain fact. Publication identity and tracing belong to adapters. */
export abstract class DomainEvent {
  public readonly aggregateId: string;

  constructor(props: DomainEventProps<unknown>) {
    if (Guard.isEmpty(props)) {
      throw new ArgumentNotProvidedException(
        'DomainEvent props should not be empty',
      );
    }
    this.aggregateId = props.aggregateId;
  }
}

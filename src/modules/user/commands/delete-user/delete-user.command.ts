import { Command, type CommandProps } from '@starter/core/domain';

export class DeleteUserCommand extends Command {
  readonly userId: string;

  constructor(props: CommandProps<DeleteUserCommand>) {
    super(props);
    this.userId = props.userId;
  }
}

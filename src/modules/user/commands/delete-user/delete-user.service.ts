import { DeleteUserCommand } from './delete-user.command';
import { NotFoundException } from '@libs/exceptions';
import type { UserRepositoryPort } from '@modules/user/database/user.repository.port';
import { Inject } from '@nestjs/common';
import { CommandHandler } from '@nestjs/cqrs';
import { Err, Ok, Result } from 'oxide.ts';
import { USER_REPOSITORY } from '../../user.di-tokens';

@CommandHandler(DeleteUserCommand)
export class DeleteUserService {
  constructor(
    @Inject(USER_REPOSITORY)
    private readonly userRepo: UserRepositoryPort,
  ) {}

  async execute(
    command: DeleteUserCommand,
  ): Promise<Result<boolean, NotFoundException>> {
    const found = await this.userRepo.findOneById(command.userId);
    if (found.isNone()) return Err(new NotFoundException());
    const user = found.unwrap();
    user.delete();
    const result = await this.userRepo.delete(user);
    return Ok(result);
  }
}

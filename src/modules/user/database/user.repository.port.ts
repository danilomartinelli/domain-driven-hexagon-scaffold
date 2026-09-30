import type { RepositoryPort } from '@starter/core/domain';
import { UserEntity } from '../domain/user.entity';

export interface UserRepositoryPort extends RepositoryPort<UserEntity> {
  findOneByEmail(email: string): Promise<UserEntity | null>;
}

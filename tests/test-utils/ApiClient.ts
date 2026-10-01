import { IdResponse } from '@starter/nest-support/http';
export interface CreateUserRequestDto {
  email: string;
  country: string;
  postalCode: string;
  street: string;
}
export interface UserResponseDto extends CreateUserRequestDto {
  id: string;
}
interface UserPaginatedResponseDto {
  data: UserResponseDto[];
}
import { getHttpServer } from '@tests/setup/test-server';

export class ApiClient {
  private url = '/v1/users';

  async createUser(dto: CreateUserRequestDto): Promise<IdResponse> {
    const response = await getHttpServer().post(this.url).send(dto);
    return response.body as IdResponse;
  }

  async deleteUser(id: string): Promise<unknown> {
    const response = await getHttpServer().delete(`${this.url}/${id}`);
    return response.body as unknown;
  }

  async findAllUsers(): Promise<UserPaginatedResponseDto> {
    const response = await getHttpServer().get(this.url);
    return response.body as UserPaginatedResponseDto;
  }
}

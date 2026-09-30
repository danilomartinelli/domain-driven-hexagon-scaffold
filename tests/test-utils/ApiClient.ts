import { routesV1 } from '@src/configs/app.routes';
import { IdResponse } from '@starter/nest-support/http';
import { CreateUserRequestDto } from '@src/modules/user/commands/create-user/create-user.request.dto';
import { UserPaginatedResponseDto } from '@src/modules/user/dtos/user.paginated.response.dto';
import { getHttpServer } from '@tests/setup/test-server';

export class ApiClient {
  private url = `/${routesV1.version}/${routesV1.user.root}`;

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

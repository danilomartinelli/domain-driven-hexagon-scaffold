import {
  Controller,
  Get,
  HttpStatus,
  NotFoundException,
  Param,
} from '@nestjs/common';
import { ApiOperation, ApiResponse } from '@nestjs/swagger';
import { ApiErrorResponse } from '@starter/nest-support/http';
import { routesV1 } from '../../configs/app.routes';
import { FindWalletByUser } from '../../application/find-wallet-by-user';
import { WalletResponseDto } from '../../dtos/wallet.response.dto';

@Controller(routesV1.version)
export class FindWalletByUserHttpController {
  constructor(private readonly findWalletByUser: FindWalletByUser) {}

  @Get(routesV1.wallet.byUser)
  @ApiOperation({ summary: "Find a User's Wallet" })
  @ApiResponse({ status: HttpStatus.OK, type: WalletResponseDto })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'The User has no Wallet',
    type: ApiErrorResponse,
  })
  async findByUser(
    @Param('userId') userId: string,
  ): Promise<WalletResponseDto> {
    const wallet = await this.findWalletByUser.execute(userId);
    if (!wallet) throw new NotFoundException('Wallet not found');
    return new WalletResponseDto(wallet);
  }
}

import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { RequestContextService } from './AppRequestContext';

@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(_request: Request, _response: Response, next: NextFunction): void {
    RequestContextService.run(next);
  }
}

import {
  BadRequestException,
  type CallHandler,
  type ExecutionContext,
  Logger,
  type NestInterceptor,
} from '@nestjs/common';
import { Observable, throwError } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { ExceptionBase } from '@starter/core/errors';
import { RequestContextService } from '../context/AppRequestContext';
import { ApiErrorResponse } from '../../api/api-error.response';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export class ExceptionInterceptor implements NestInterceptor {
  private readonly logger: Logger = new Logger(ExceptionInterceptor.name);

  intercept(
    _context: ExecutionContext,
    next: CallHandler,
  ): Observable<ExceptionBase> {
    return next.handle().pipe(
      catchError((error: unknown) => {
        if (!isRecord(error)) return throwError(() => error);
        let err = error;
        // Logging for debugging purposes
        if (
          typeof err.status === 'number' &&
          err.status >= 400 &&
          err.status < 500
        ) {
          this.logger.debug(
            `[${RequestContextService.getRequestId()}] ${String(err.message)}`,
          );

          const response = err.response;
          // Transforming class-validator errors to a different format
          if (
            isRecord(response) &&
            Array.isArray(response.message) &&
            response.message.every(
              (message: unknown) => typeof message === 'string',
            ) &&
            typeof response.error === 'string' &&
            err.status === 400
          ) {
            err = new BadRequestException(
              new ApiErrorResponse({
                statusCode: err.status,
                message: 'Validation error',
                error: response.error,
                subErrors: response.message,
                correlationId: RequestContextService.getRequestId(),
              }),
            ) as unknown as Record<string, unknown>;
          }
        }

        // Adding request ID to error message
        if (!err.correlationId) {
          err.correlationId = RequestContextService.getRequestId();
        }

        if (isRecord(err.response)) {
          err.response.correlationId = err.correlationId;
        }

        return throwError(() => err);
      }),
    );
  }
}

import {
  ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { DomainException } from './domain.exception';
import { ErrorCode } from './error-codes';

interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
    requestId: string;
  };
}

/**
 * One error shape for the entire API. Documented in docs/02-specs/api/conventions.md.
 *
 * An unexpected error never leaks internals: the client gets a requestId, and the
 * detail goes to the log where it belongs.
 */
@Catch()
export class DomainExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(DomainExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const res = http.getResponse<Response>();
    const req = http.getRequest<Request & { id?: string }>();
    const requestId = String(req.id ?? req.headers['x-request-id'] ?? 'unknown');

    const { status, body } = this.render(exception, requestId);

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        { requestId, path: req.url, err: exception },
        'unhandled error serving request',
      );
    }

    res.status(status).json(body);
  }

  private render(exception: unknown, requestId: string): { status: number; body: ErrorEnvelope } {
    if (exception instanceof DomainException) {
      const payload = exception.getResponse() as {
        code: string;
        message: string;
        details?: Record<string, unknown>;
      };
      return {
        status: exception.getStatus(),
        body: { error: { ...payload, requestId } },
      };
    }

    if (exception instanceof HttpException) {
      const response = exception.getResponse();
      const message =
        typeof response === 'string'
          ? response
          : ((response as { message?: string | string[] }).message ?? exception.message);
      const isValidation = exception.getStatus() === HttpStatus.BAD_REQUEST;
      return {
        status: exception.getStatus(),
        body: {
          error: {
            code: isValidation ? ErrorCode.VALIDATION_FAILED : ErrorCode.INTERNAL_ERROR,
            message: Array.isArray(message) ? message.join('; ') : String(message),
            ...(Array.isArray(message) ? { details: { violations: message } } : {}),
            requestId,
          },
        },
      };
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: {
        error: {
          code: ErrorCode.INTERNAL_ERROR,
          message: 'Something went wrong. Quote the request id if you contact support.',
          requestId,
        },
      },
    };
  }
}

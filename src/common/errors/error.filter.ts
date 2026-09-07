import {
  ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { DomainException } from './domain.exception';
import { ErrorCode } from './error-codes';
import { MissingTenantContextError } from '@/common/tenancy/tenant-scope.error';

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

    /**
     * The tenancy backstop, firing.
     *
     * `MissingTenantContextError` means a scoped query was attempted with no office to
     * scope it to — a grant the route cannot honour, or a service reached without a
     * membership. It is a **refusal**, not a fault: rendering it as 500 told the caller
     * the server broke and put an "unhandled error" line in the log for something the
     * system detected correctly and stopped. `org_tree:read`'s Super Admin grant spent a
     * phase doing exactly that.
     *
     * 403 rather than 404 because there is nothing to hide: the caller learns their
     * request had no tenant, not whether anything exists in one.
     */
    if (exception instanceof MissingTenantContextError) {
      return {
        status: HttpStatus.FORBIDDEN,
        body: {
          error: {
            code: ErrorCode.TENANT_NO_MEMBERSHIP,
            message: 'This request needs an office, and yours resolves to none.',
            // No details: the error's own message names the collection and the
            // operation, which is for the log and not for the caller.
            requestId,
          },
        },
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

import {
  ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { readerOfRequest, type Reader, type ReaderCarrier } from '@/common/i18n/reader';
import { render, type Sentence } from '@/common/i18n/sentence';
import { legacyViolation } from '@/common/validation/violations';
import { DomainException } from './domain.exception';
import { ErrorCode, type ErrorCodeValue } from './error-codes';
import { ERROR_REFUSALS } from './error.messages';
import { MissingTenantContextError } from '@/common/tenancy/tenant-scope.error';
import { redactUrl } from '@/common/logging/redact-url';

/**
 * **The code a framework exception carries, by its status.** Nest's own exceptions, never one of ours: the
 * router's *"Cannot GET /x"* (404), a guard that answered `false` (403), the global pipe's refusal (400). Each
 * takes the catalog's code for its status. `INTERNAL_ERROR` is the catalog's 500 and nothing else: a 404 that
 * called itself an internal error sent whoever opened the API's root looking for a fault (staging's first day,
 * 2026-10-24). A status with no catalog code of its own is still `INTERNAL_ERROR`.
 */
const FRAMEWORK_CODES: Readonly<Partial<Record<number, ErrorCodeValue>>> = {
  [HttpStatus.BAD_REQUEST]: ErrorCode.VALIDATION_FAILED,
  [HttpStatus.UNAUTHORIZED]: ErrorCode.AUTH_TOKEN_INVALID,
  [HttpStatus.FORBIDDEN]: ErrorCode.PERM_DENIED,
  [HttpStatus.NOT_FOUND]: ErrorCode.NOT_FOUND,
};

/**
 * **A framework exception's words, in the reader's language** (P18.98-T5 AC-2): Nest's English as Nest wrote it — every
 * assertion on *"Cannot GET /x"* stands — and, in Indonesian, what its status means.
 */
function frameworkSentence(code: ErrorCodeValue, english: string): Sentence {
  switch (code) {
    case ErrorCode.VALIDATION_FAILED: return ERROR_REFUSALS.VALIDATION_FAILED.framework({ english });
    case ErrorCode.AUTH_TOKEN_INVALID: return ERROR_REFUSALS.AUTH_TOKEN_INVALID.framework({ english });
    case ErrorCode.PERM_DENIED: return ERROR_REFUSALS.PERM_DENIED.framework({ english });
    case ErrorCode.NOT_FOUND: return ERROR_REFUSALS.NOT_FOUND.framework({ english });
    default: return ERROR_REFUSALS.INTERNAL_ERROR.framework({ english });
  }
}

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
    const req = http.getRequest<Request & { id?: string } & ReaderCarrier>();
    const requestId = String(req.id ?? req.headers['x-request-id'] ?? 'unknown');

    // The request's reader (P18.98-T5 AC-1): resolved by `AuthGuard`, or read off the header for a request no guard saw.
    const { status, body } = this.render(exception, requestId, readerOfRequest(req));

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        // A shared link's token is in its path, and never reaches a log (ADR-0131 §1).
        { requestId, path: redactUrl(req.url), err: exception },
        'unhandled error serving request',
      );
    }

    res.status(status).json(body);
  }

  private render(exception: unknown, requestId: string, request: Reader): { status: number; body: ErrorEnvelope } {
    if (exception instanceof DomainException) {
      /*
       * **Written for its reader** (P18.98-T5 AC-2, AC-3): the sentence in their language, and every sentence in
       * `details` — `violations` — with it. `code` and every other detail are the same in both languages.
       */
      const reader = exception.readerOr(request);
      const details = exception.detailsFor(reader);
      return {
        status: exception.getStatus(),
        body: {
          error: {
            code: exception.code,
            message: exception.messageFor(reader),
            ...(details === undefined ? {} : { details }),
            requestId,
          },
        },
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
            message: render(ERROR_REFUSALS.TENANT_NO_MEMBERSHIP.noOffice, request),
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
      const code = FRAMEWORK_CODES[exception.getStatus()] ?? ErrorCode.INTERNAL_ERROR;
      /*
       * **A list is violations Nest wrote** — a pipe built without `VALIDATION_PIPE_OPTIONS`' factory: each is read as
       * class-validator's and written for the reader, as the factory writes them. A single message is Nest's, and
       * Indonesian says what its status means (P18.98-T5 AC-2).
       */
      const violations = Array.isArray(message) ? message.map((text) => render(legacyViolation(String(text)), request)) : null;
      return {
        status: exception.getStatus(),
        body: {
          error: {
            code,
            message: violations ? violations.join('; ') : render(frameworkSentence(code, String(message)), request),
            ...(violations ? { details: { violations } } : {}),
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
          message: render(ERROR_REFUSALS.INTERNAL_ERROR.unexpected, request),
          requestId,
        },
      },
    };
  }
}

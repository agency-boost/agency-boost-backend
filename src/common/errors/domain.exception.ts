import { HttpException, HttpStatus } from '@nestjs/common';
import { ErrorCode, ErrorCodeValue } from './error-codes';

/** Base class for every expected failure. Never throw a string. */
export class DomainException extends HttpException {
  constructor(
    readonly code: ErrorCodeValue,
    message: string,
    status: HttpStatus,
    readonly details?: Record<string, unknown>,
  ) {
    super({ code, message, details }, status);
  }
}

/**
 * Not found — and also what a resource in another tenant returns.
 *
 * A 403 would confirm the id exists, which is itself tenant information. This is the
 * one place where being unhelpful is the correct behaviour (ADR-0002).
 */
export class NotFoundException extends DomainException {
  constructor(resource: string, details?: Record<string, unknown>) {
    super(ErrorCode.NOT_FOUND, `${resource} not found.`, HttpStatus.NOT_FOUND, details);
  }
}

export class PermissionDeniedException extends DomainException {
  constructor(permission: string, details?: Record<string, unknown>) {
    super(
      ErrorCode.PERM_DENIED,
      `You do not have permission to perform this action.`,
      HttpStatus.FORBIDDEN,
      { permission, ...details },
    );
  }
}

export class TenantSuspendedException extends DomainException {
  constructor() {
    super(
      ErrorCode.TENANT_SUSPENDED,
      `This office is suspended. Contact your KPM Owner.`,
      HttpStatus.FORBIDDEN,
    );
  }
}

export class NoMembershipException extends DomainException {
  constructor() {
    super(
      ErrorCode.TENANT_NO_MEMBERSHIP,
      `You have not joined a KPM yet. Register your office to continue.`,
      HttpStatus.FORBIDDEN,
    );
  }
}

export class VersionConflictException extends DomainException {
  constructor(expected: number, actual: number) {
    super(
      ErrorCode.VERSION_CONFLICT,
      `This record changed since you loaded it. Reload and try again.`,
      HttpStatus.CONFLICT,
      { expectedVersion: expected, actualVersion: actual },
    );
  }
}

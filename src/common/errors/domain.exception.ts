import { HttpException, HttpStatus } from '@nestjs/common';
import { inSource, renderDeep, render, type Sentence } from '@/common/i18n/sentence';
import { SOURCE_READER, type Reader } from '@/common/i18n/reader';
import { ErrorCode, ErrorCodeValue } from './error-codes';
import { ERROR_REFUSALS } from './error.messages';
import type { ResourceName } from './resources';

/**
 * Base class for every expected failure. Never throw a string.
 *
 * **Its words are a sentence out of the module's catalogue, in both languages** (P18.10-T5 AC-2), filed under the code
 * it is raised with — `tsc` refuses another code's sentence. The response is written for the request's reader by
 * `DomainExceptionFilter`; `code` and `details` are the same in both languages, and clients still switch on the code.
 *
 * `Error.message` and `getResponse()` hold the English the API wrote before the phase (`SOURCE_READER`), so a log line
 * and a unit test read what they always read. `details` may carry sentences too — a service's field sentences, under
 * `violations` (AC-3) — and is held here as English, and written for the reader in the response (`detailsFor`).
 */
export class DomainException<C extends ErrorCodeValue = ErrorCodeValue> extends HttpException {
  /** The refusal's words, both languages. */
  readonly sentence: Sentence<C>;
  /** `details` as English — what a test or a caller that re-raises reads. */
  readonly details?: Record<string, unknown>;
  /**
   * `details` as given, sentences and all — what the response is written from, and what a caller that catches a
   * refusal and raises it again (naming the change it came from, say) passes on, so its sentences keep both languages.
   */
  readonly givenDetails?: Record<string, unknown>;
  /** The reader it was written for, where the thrower knew better than the request (`writtenFor`). */
  private reader?: Reader;

  constructor(
    readonly code: C,
    message: Sentence<NoInfer<C>>,
    status: HttpStatus,
    details?: Record<string, unknown>,
  ) {
    const english = details === undefined ? undefined : renderDeep(details, SOURCE_READER);
    super({ code, message: inSource(message), details: english }, status);
    this.sentence = message;
    this.details = english;
    this.givenDetails = details;
  }

  /**
   * **Written for a reader the thrower knows** — the person `ContextResolver` has just read, refused before the request
   * carries their saved language (their office suspended, their account deactivated). Answers the same exception.
   */
  writtenFor(reader: Reader): this {
    this.reader = reader;
    return this;
  }

  /** The reader to write it for: the one it was written for, or the request's. */
  readerOr(request: Reader): Reader {
    return this.reader ?? request;
  }

  /** The refusal's words, for a reader. */
  messageFor(reader: Reader): string {
    return render(this.sentence, reader);
  }

  /** `details`, every sentence in it written for a reader. */
  detailsFor(reader: Reader): Record<string, unknown> | undefined {
    return this.givenDetails === undefined ? undefined : renderDeep(this.givenDetails, reader);
  }
}

/**
 * Not found — and also what a resource in another tenant returns.
 *
 * A 403 would confirm the id exists, which is itself tenant information. This is the
 * one place where being unhelpful is the correct behaviour (ADR-0002).
 *
 * **The resource is named from one list, in both languages** (`resources.ts`), so a name no list holds fails `tsc`.
 */
export class NotFoundException extends DomainException<'NOT_FOUND'> {
  constructor(resource: ResourceName, details?: Record<string, unknown>) {
    super(ErrorCode.NOT_FOUND, ERROR_REFUSALS.NOT_FOUND.resource({ resource }), HttpStatus.NOT_FOUND, details);
  }
}

export class PermissionDeniedException extends DomainException<'PERM_DENIED'> {
  constructor(permission: string, details?: Record<string, unknown>) {
    super(ErrorCode.PERM_DENIED, ERROR_REFUSALS.PERM_DENIED.noPermission, HttpStatus.FORBIDDEN, { permission, ...details });
  }
}

export class TenantSuspendedException extends DomainException<'TENANT_SUSPENDED'> {
  constructor() {
    super(ErrorCode.TENANT_SUSPENDED, ERROR_REFUSALS.TENANT_SUSPENDED.contactOwner, HttpStatus.FORBIDDEN);
  }
}

export class NoMembershipException extends DomainException<'TENANT_NO_MEMBERSHIP'> {
  constructor() {
    super(ErrorCode.TENANT_NO_MEMBERSHIP, ERROR_REFUSALS.TENANT_NO_MEMBERSHIP.notJoined, HttpStatus.FORBIDDEN);
  }
}

export class VersionConflictException extends DomainException<'VERSION_CONFLICT'> {
  constructor(expected: number, actual: number) {
    super(
      ErrorCode.VERSION_CONFLICT,
      ERROR_REFUSALS.VERSION_CONFLICT.reload,
      HttpStatus.CONFLICT,
      { expectedVersion: expected, actualVersion: actual },
    );
  }
}

/**
 * **A request the API refuses as malformed**, `400 VALIDATION_FAILED`: what a service raises where Nest's
 * `BadRequestException` was raised with a bare English string (P18.10-T5 AC-3). The same answer on the wire — the code,
 * the status, no `details` unless given — with its words in both languages.
 */
export class InvalidRequestException extends DomainException<'VALIDATION_FAILED'> {
  constructor(message: Sentence<'VALIDATION_FAILED'>, details?: Record<string, unknown>) {
    super(ErrorCode.VALIDATION_FAILED, message, HttpStatus.BAD_REQUEST, details);
  }
}

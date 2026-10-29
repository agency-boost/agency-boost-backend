import { HttpStatus } from '@nestjs/common';
import { DomainException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { joinSentences, type Sentence } from '@/common/i18n/sentence';
import { VALIDATION_REFUSALS } from './validation.messages';
import { field } from './violations';

/**
 * Reading one request body by field — shared by every module's input checkers (ADR-0030).
 *
 * The rules themselves live with the module that owns the data (`config-input.ts`,
 * `training-input.ts`). What lives here is **how** a rule is read and how a refusal is shaped,
 * so two modules cannot answer the same mistake in two ways.
 */

/** How a code may be typed. Case is forgiven; the code saved is upper case. */
export const CODE_PATTERN = /^[A-Za-z][A-Za-z0-9_]{2,39}$/;
/** What a code's refusal says (P18.98-T5 AC-3): a service's sentence, in both languages. */
export const CODE_SENTENCE = VALIDATION_REFUSALS.VALIDATION_FAILED.codeShape;
/** The same, as a DTO's `@Matches` takes it (`field`). */
export const CODE_MESSAGE = field(CODE_SENTENCE);

/** A field's sentence, as a service's checker writes it: one of its module's, under `VALIDATION_FAILED`. */
export type FieldSentence = Sentence<'VALIDATION_FAILED'>;

const SAY = VALIDATION_REFUSALS.VALIDATION_FAILED;

export type Bounds = { readonly min: number; readonly max: number };

/**
 * One body, read field by field, **collecting every violation before refusing** — a form
 * with three mistakes hears about three, the way the pipe reports them.
 */
export class Fields {
  readonly violations: FieldSentence[] = [];
  private readonly body: Record<string, unknown>;

  constructor(raw: unknown, allowed: readonly string[]) {
    const isObject = raw !== null && typeof raw === 'object' && !Array.isArray(raw);
    this.body = isObject ? (raw as Record<string, unknown>) : {};
    if (!isObject) this.violations.push(SAY.notAnObject);
    // The pipe's `forbidNonWhitelisted`, for the path the pipe never sees: a misspelt field
    // quietly ignored is the hardest kind of bug to find.
    for (const key of Object.keys(this.body)) {
      if (!allowed.includes(key) && this.body[key] !== undefined) {
        this.violations.push(SAY.unknownField({ key }));
      }
    }
  }

  /** Text, trimmed, within bounds. */
  text(field: string, bounds: Bounds, required: boolean): string | undefined {
    const value = this.body[field];
    if (value === undefined) {
      if (required) this.violations.push(SAY.required({ field }));
      return undefined;
    }
    if (typeof value !== 'string') {
      this.violations.push(SAY.notText({ field }));
      return undefined;
    }
    const trimmed = value.trim();
    if (trimmed.length < bounds.min || trimmed.length > bounds.max) {
      this.violations.push(SAY.textBetween({ field, min: bounds.min, max: bounds.max }));
    }
    return trimmed;
  }

  /**
   * Free text that can be cleared: absent leaves it alone, `null` or blank clears it.
   * Blank and absent are the same fact about a description, and should read alike.
   */
  note(field: string, bounds: { readonly max: number }): string | null | undefined {
    const value = this.body[field];
    if (value === undefined) return undefined;
    if (value === null) return null;
    if (typeof value !== 'string') {
      this.violations.push(SAY.notText({ field }));
      return undefined;
    }
    const trimmed = value.trim();
    if (trimmed.length > bounds.max) {
      this.violations.push(SAY.textAtMost({ field, max: bounds.max }));
    }
    return trimmed || null;
  }

  /** A code, upper-cased. */
  code(field: string, required: boolean): string | undefined {
    const value = this.body[field];
    if (value === undefined) {
      if (required) this.violations.push(SAY.required({ field }));
      return undefined;
    }
    if (typeof value !== 'string' || !CODE_PATTERN.test(value.trim())) {
      this.violations.push(SAY.fieldCodeShape({ field }));
      return undefined;
    }
    return value.trim().toUpperCase();
  }

  /**
   * A list of codes. Normalising and resolving them is the service's, against the database.
   * `outOfBounds` words the count refusal where a generic one would say less.
   */
  codes(
    field: string,
    bounds: Bounds,
    required: boolean,
    outOfBounds: (count: number) => FieldSentence = () => SAY.codesBetween({ field, min: bounds.min, max: bounds.max }),
  ): string[] | undefined {
    const value = this.body[field];
    if (value === undefined) {
      if (required) this.violations.push(SAY.required({ field }));
      return undefined;
    }
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
      this.violations.push(SAY.notCodes({ field }));
      return undefined;
    }
    if (value.length < bounds.min || value.length > bounds.max) {
      this.violations.push(outOfBounds(value.length));
    }
    return value as string[];
  }

  number(field: string, bounds: Bounds, required: boolean): number | undefined {
    const value = this.body[field];
    if (value === undefined) {
      if (required) this.violations.push(SAY.required({ field }));
      return undefined;
    }
    if (
      typeof value !== 'number' || !Number.isFinite(value)
      || value < bounds.min || value > bounds.max
    ) {
      this.violations.push(SAY.numberBetween({ field, min: bounds.min, max: bounds.max }));
      return undefined;
    }
    return value;
  }

  oneOf<T extends string>(field: string, values: readonly T[], required: boolean): T | undefined {
    const value = this.body[field];
    if (value === undefined) {
      if (required) this.violations.push(SAY.required({ field }));
      return undefined;
    }
    if (typeof value !== 'string' || !values.includes(value as T)) {
      this.violations.push(SAY.oneOf({ field, values }));
      return undefined;
    }
    return value as T;
  }

  /**
   * The checked input, or the refusal.
   *
   * `VALIDATION_FAILED` with `details.violations`, the shape `ValidationPipe` produces, so a
   * client cannot tell which layer refused. Absent fields are dropped rather than carried as
   * `undefined`, so a service's "nothing to change" still sees an empty change.
   */
  done<T extends object>(input: T): T {
    if (this.violations.length > 0) {
      throw new DomainException(
        ErrorCode.VALIDATION_FAILED,
        joinSentences(this.violations, '; '),
        HttpStatus.BAD_REQUEST,
        { violations: [...this.violations] },
      );
    }
    return Object.fromEntries(
      Object.entries(input).filter(([, value]) => value !== undefined),
    ) as T;
  }
}

/**
 * Refuse with violations gathered outside a single `Fields` — a document checked object by object,
 * such as the activation checklist's aspects and items (P5-T3).
 *
 * The same shape `Fields.done` throws, so a client still cannot tell which layer refused, and a form
 * with three mistakes still hears about three.
 */
export function refuseWith(violations: readonly FieldSentence[]): never {
  throw new DomainException(
    ErrorCode.VALIDATION_FAILED,
    joinSentences(violations, '; '),
    HttpStatus.BAD_REQUEST,
    { violations: [...violations] },
  );
}

// ---------------------------------------------------------- archive and restore

/** An archive or a restore names a row and carries nothing else. */
export function checkNoFields(body: unknown): void {
  new Fields(body ?? {}, []).done({});
}

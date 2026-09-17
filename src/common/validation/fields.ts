import { HttpStatus } from '@nestjs/common';
import { DomainException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';

/**
 * Reading one request body by field — shared by every module's input checkers (ADR-0030).
 *
 * The rules themselves live with the module that owns the data (`config-input.ts`,
 * `training-input.ts`). What lives here is **how** a rule is read and how a refusal is shaped,
 * so two modules cannot answer the same mistake in two ways.
 */

/** How a code may be typed. Case is forgiven; the code saved is upper case. */
export const CODE_PATTERN = /^[A-Za-z][A-Za-z0-9_]{2,39}$/;
export const CODE_MESSAGE =
  'A code is 3–40 characters of A–Z, 0–9 and underscore, starting with a letter.';

export type Bounds = { readonly min: number; readonly max: number };

/**
 * One body, read field by field, **collecting every violation before refusing** — a form
 * with three mistakes hears about three, the way the pipe reports them.
 */
export class Fields {
  readonly violations: string[] = [];
  private readonly body: Record<string, unknown>;

  constructor(raw: unknown, allowed: readonly string[]) {
    const isObject = raw !== null && typeof raw === 'object' && !Array.isArray(raw);
    this.body = isObject ? (raw as Record<string, unknown>) : {};
    if (!isObject) this.violations.push('The change must be an object of fields.');
    // The pipe's `forbidNonWhitelisted`, for the path the pipe never sees: a misspelt field
    // quietly ignored is the hardest kind of bug to find.
    for (const key of Object.keys(this.body)) {
      if (!allowed.includes(key) && this.body[key] !== undefined) {
        this.violations.push(`property ${key} should not exist`);
      }
    }
  }

  /** Text, trimmed, within bounds. */
  text(field: string, bounds: Bounds, required: boolean): string | undefined {
    const value = this.body[field];
    if (value === undefined) {
      if (required) this.violations.push(`${field} is required.`);
      return undefined;
    }
    if (typeof value !== 'string') {
      this.violations.push(`${field} must be text.`);
      return undefined;
    }
    const trimmed = value.trim();
    if (trimmed.length < bounds.min || trimmed.length > bounds.max) {
      this.violations.push(`${field} must be ${bounds.min}–${bounds.max} characters.`);
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
      this.violations.push(`${field} must be text.`);
      return undefined;
    }
    const trimmed = value.trim();
    if (trimmed.length > bounds.max) {
      this.violations.push(`${field} must be at most ${bounds.max} characters.`);
    }
    return trimmed || null;
  }

  /** A code, upper-cased. */
  code(field: string, required: boolean): string | undefined {
    const value = this.body[field];
    if (value === undefined) {
      if (required) this.violations.push(`${field} is required.`);
      return undefined;
    }
    if (typeof value !== 'string' || !CODE_PATTERN.test(value.trim())) {
      this.violations.push(`${field}: ${CODE_MESSAGE}`);
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
    outOfBounds: (count: number) => string = () =>
      `${field} must name ${bounds.min}–${bounds.max} codes.`,
  ): string[] | undefined {
    const value = this.body[field];
    if (value === undefined) {
      if (required) this.violations.push(`${field} is required.`);
      return undefined;
    }
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
      this.violations.push(`${field} must be a list of codes.`);
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
      if (required) this.violations.push(`${field} is required.`);
      return undefined;
    }
    if (
      typeof value !== 'number' || !Number.isFinite(value)
      || value < bounds.min || value > bounds.max
    ) {
      this.violations.push(`${field} must be a number from ${bounds.min} to ${bounds.max}.`);
      return undefined;
    }
    return value;
  }

  oneOf<T extends string>(field: string, values: readonly T[], required: boolean): T | undefined {
    const value = this.body[field];
    if (value === undefined) {
      if (required) this.violations.push(`${field} is required.`);
      return undefined;
    }
    if (typeof value !== 'string' || !values.includes(value as T)) {
      this.violations.push(`${field} must be one of ${values.join(', ')}.`);
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
        this.violations.join('; '),
        HttpStatus.BAD_REQUEST,
        { violations: [...this.violations] },
      );
    }
    return Object.fromEntries(
      Object.entries(input).filter(([, value]) => value !== undefined),
    ) as T;
  }
}

// ---------------------------------------------------------- archive and restore

/** An archive or a restore names a row and carries nothing else. */
export function checkNoFields(body: unknown): void {
  new Fields(body ?? {}, []).done({});
}

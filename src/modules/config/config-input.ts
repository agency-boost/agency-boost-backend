import { HttpStatus } from '@nestjs/common';
import { DomainException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { RATIO_DISPLAY_UNITS, type RatioDisplayUnit } from '@/domain/constants';
import { LEAD_PIPELINES, type LeadPipeline } from './lead-status.schema';
import { RATIO_COMPARISONS, type RatioComparison } from './ratio-definition.schema';

/**
 * What a configuration write may contain — decided once, for every way a write arrives
 * (ADR-0030).
 *
 * **Why here and not only in the DTOs.** The settings screens save through the staged batch,
 * whose op bodies are plain objects the `ValidationPipe` never sees; the DTOs guarded only the
 * single-operation routes, which nothing uses any more. A 5,000-character label and a
 * benchmark of 99,999 were written through the batch, and a label sent as a number failed at
 * `.trim()` *after* the ops before it had been written (OD-51).
 *
 * So each write has one checker. The service calls it before it writes, and the batch's
 * validate pass calls the same one before it writes anything at all. The DTOs keep their
 * decorators — the pipe's whitelist and the OpenAPI document need them — and take their numbers
 * and their code pattern from here, so the bounds cannot drift. `config-input.spec.ts` runs
 * the same boundary inputs through both and requires the same verdict, so the logic cannot
 * drift either.
 */

/** How a code may be typed. Case is forgiven; the code saved is upper case. */
export const CODE_PATTERN = /^[A-Za-z][A-Za-z0-9_]{2,39}$/;
export const CODE_MESSAGE =
  'A code is 3–40 characters of A–Z, 0–9 and underscore, starting with a letter.';

export const CONFIG_BOUNDS = {
  categoryLabel: { min: 1, max: 80 },
  typeLabel: { min: 1, max: 200 },
  ratioLabel: { min: 1, max: 80 },
  leadStatusLabel: { min: 1, max: 80 },
  description: { max: 200 },
  rungs: { max: 20 },
  formulaTerms: { min: 1, max: 50 },
  /**
   * `gte` ratios are proportions — 0.15, 1.50 — and `band` is percentage points either side
   * of an even split, so 30 means ±30pp. One field covers both, and 0–1000 is wide enough
   * for either while still refusing a typo that slipped a decimal point.
   */
  benchmark: { min: 0, max: 1000 },
} as const;

type Bounds = { readonly min: number; readonly max: number };

/**
 * One body, read field by field, **collecting every violation before refusing** — a form
 * with three mistakes hears about three, the way the pipe reports them.
 */
class Fields {
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

// ------------------------------------------------------------- activity categories

export interface CategoryCreateInput {
  code: string;
  label: string;
  description: string | null;
  appliesToOrgLevelCodes: string[];
}

export function checkCategoryCreate(body: unknown): CategoryCreateInput {
  const f = new Fields(body, ['code', 'label', 'description', 'appliesToOrgLevelCodes']);
  return f.done({
    code: f.code('code', true),
    label: f.text('label', CONFIG_BOUNDS.categoryLabel, true),
    description: f.note('description', CONFIG_BOUNDS.description) ?? null,
    appliesToOrgLevelCodes:
      f.codes('appliesToOrgLevelCodes', { min: 0, ...CONFIG_BOUNDS.rungs }, false) ?? [],
  }) as CategoryCreateInput;
}

/** No `code`: every activity, ratio and goal points at it (ADR-0006). */
export interface CategoryUpdateInput {
  label?: string;
  description?: string | null;
  appliesToOrgLevelCodes?: string[];
}

export function checkCategoryUpdate(body: unknown): CategoryUpdateInput {
  const f = new Fields(body, ['label', 'description', 'appliesToOrgLevelCodes']);
  return f.done({
    label: f.text('label', CONFIG_BOUNDS.categoryLabel, false),
    description: f.note('description', CONFIG_BOUNDS.description),
    appliesToOrgLevelCodes: f.codes('appliesToOrgLevelCodes', { min: 0, ...CONFIG_BOUNDS.rungs }, false),
  });
}

// ------------------------------------------------------------------ activity types

export interface TypeCreateInput {
  code: string;
  categoryCode: string;
  label: string;
  description: string | null;
}

export function checkTypeCreate(body: unknown): TypeCreateInput {
  const f = new Fields(body, ['code', 'categoryCode', 'label', 'description']);
  return f.done({
    code: f.code('code', true),
    categoryCode: f.code('categoryCode', true),
    label: f.text('label', CONFIG_BOUNDS.typeLabel, true),
    description: f.note('description', CONFIG_BOUNDS.description) ?? null,
  }) as TypeCreateInput;
}

export interface TypeUpdateInput {
  label?: string;
  description?: string | null;
  categoryCode?: string;
}

export function checkTypeUpdate(body: unknown): TypeUpdateInput {
  const f = new Fields(body, ['label', 'description', 'categoryCode']);
  return f.done({
    label: f.text('label', CONFIG_BOUNDS.typeLabel, false),
    description: f.note('description', CONFIG_BOUNDS.description),
    categoryCode: f.code('categoryCode', false),
  });
}

// ------------------------------------------------------------------------- ratios

export interface RatioCreateInput {
  code: string;
  label: string;
  numerator: string[];
  denominator: string[];
  benchmark: number;
  comparison: RatioComparison;
  displayUnit?: RatioDisplayUnit;
  appliesToOrgLevelCodes: string[];
}

/**
 * An empty side is a division by zero dressed up as configuration, and it would render as `∞`
 * or `NaN` on every agent's screen — so the refusal says what a ratio needs, not a count.
 */
const side = (name: 'numerator' | 'denominator') => (count: number) => (count === 0
  ? `A ratio needs at least one activity type in its ${name}.`
  : `A ratio counts at most ${CONFIG_BOUNDS.formulaTerms.max} activity types in its ${name}.`);

const RATIO_FIELDS = [
  'label', 'numerator', 'denominator', 'benchmark', 'comparison', 'displayUnit',
  'appliesToOrgLevelCodes',
] as const;

export function checkRatioCreate(body: unknown): RatioCreateInput {
  const f = new Fields(body, ['code', ...RATIO_FIELDS]);
  return f.done({
    code: f.code('code', true),
    label: f.text('label', CONFIG_BOUNDS.ratioLabel, true),
    numerator: f.codes('numerator', CONFIG_BOUNDS.formulaTerms, true, side('numerator')),
    denominator: f.codes('denominator', CONFIG_BOUNDS.formulaTerms, true, side('denominator')),
    benchmark: f.number('benchmark', CONFIG_BOUNDS.benchmark, true),
    comparison: f.oneOf('comparison', RATIO_COMPARISONS, true),
    displayUnit: f.oneOf('displayUnit', RATIO_DISPLAY_UNITS, false),
    appliesToOrgLevelCodes:
      f.codes('appliesToOrgLevelCodes', { min: 0, ...CONFIG_BOUNDS.rungs }, false) ?? [],
  }) as RatioCreateInput;
}

/** No `code`. Everything computed from this ratio holds it. */
export interface RatioUpdateInput {
  label?: string;
  numerator?: string[];
  denominator?: string[];
  benchmark?: number;
  comparison?: RatioComparison;
  displayUnit?: RatioDisplayUnit;
  appliesToOrgLevelCodes?: string[];
}

export function checkRatioUpdate(body: unknown): RatioUpdateInput {
  const f = new Fields(body, RATIO_FIELDS);
  return f.done({
    label: f.text('label', CONFIG_BOUNDS.ratioLabel, false),
    numerator: f.codes('numerator', CONFIG_BOUNDS.formulaTerms, false, side('numerator')),
    denominator: f.codes('denominator', CONFIG_BOUNDS.formulaTerms, false, side('denominator')),
    benchmark: f.number('benchmark', CONFIG_BOUNDS.benchmark, false),
    comparison: f.oneOf('comparison', RATIO_COMPARISONS, false),
    displayUnit: f.oneOf('displayUnit', RATIO_DISPLAY_UNITS, false),
    appliesToOrgLevelCodes: f.codes('appliesToOrgLevelCodes', { min: 0, ...CONFIG_BOUNDS.rungs }, false),
  });
}

// ------------------------------------------------------------------- lead statuses

export interface LeadStatusCreateInput {
  pipeline: LeadPipeline;
  code: string;
  label: string;
}

export function checkLeadStatusCreate(body: unknown): LeadStatusCreateInput {
  const f = new Fields(body, ['pipeline', 'code', 'label']);
  return f.done({
    pipeline: f.oneOf('pipeline', LEAD_PIPELINES, true),
    code: f.code('code', true),
    label: f.text('label', CONFIG_BOUNDS.leadStatusLabel, true),
  }) as LeadStatusCreateInput;
}

/** The label only. The code is what every lead holds. */
export function checkLeadStatusLabel(label: unknown): string {
  const f = new Fields({ label }, ['label']);
  return f.done({ label: f.text('label', CONFIG_BOUNDS.leadStatusLabel, true) }).label as string;
}

// ---------------------------------------------------------- archive and restore

/** An archive or a restore names a row and carries nothing else. */
export function checkNoFields(body: unknown): void {
  new Fields(body ?? {}, []).done({});
}

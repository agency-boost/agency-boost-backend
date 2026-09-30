import { CODE_MESSAGE, CODE_PATTERN, Fields, checkNoFields } from '@/common/validation/fields';
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
 *
 * How a body is read and how a refusal is shaped are shared, in `common/validation/fields.ts`;
 * the rules for this module's data are here.
 */

/** Re-exported for the DTOs, which take their code pattern from where the rules are. */
export { CODE_MESSAGE, CODE_PATTERN, checkNoFields };

export const CONFIG_BOUNDS = {
  categoryLabel: { min: 1, max: 80 },
  /** A summary tile's label (ADR-0064) sits where a section's does, so it has a section's room. */
  summaryGroupLabel: { min: 1, max: 80 },
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

// ------------------------------------------------------------- activity categories

/** The fields a section's summary tile is set by (ADR-0064). */
const SUMMARY_GROUP_FIELDS = ['summaryGroupCode', 'summaryGroupLabel'] as const;

/** Said once, because a create, an update and a template row all refuse it the same way. */
export const SUMMARY_GROUP_PAIR_MESSAGE =
  'summaryGroupCode and summaryGroupLabel are set together, or cleared together with null.';

/**
 * A section's summary tile: both fields, or neither (ADR-0064).
 *
 * `null` clears, and is only accepted on both at once: a code with no label is a tile nobody can
 * name, and a label with no code is a tile no other section can join. **Absent leaves both
 * alone**, the way every update field here does — so an update that sends one of the two is
 * refused rather than read as half a change.
 *
 * The pair is a rule across two fields, which the pipe's per-field decorators cannot state; the
 * route reaches this checker through its service, so it refuses the same body the batch does.
 */
function summaryGroup(
  f: Fields, body: unknown,
): { summaryGroupCode?: string | null; summaryGroupLabel?: string | null } {
  const raw = (body !== null && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const [codeSent, labelSent] = SUMMARY_GROUP_FIELDS.map((key) => raw[key] !== undefined);
  const [codeNull, labelNull] = SUMMARY_GROUP_FIELDS.map((key) => raw[key] === null);

  const summaryGroupCode = codeNull ? null : f.code('summaryGroupCode', false);
  const summaryGroupLabel = labelNull
    ? null
    : f.text('summaryGroupLabel', CONFIG_BOUNDS.summaryGroupLabel, false);
  if (codeSent !== labelSent || codeNull !== labelNull) f.violations.push(SUMMARY_GROUP_PAIR_MESSAGE);
  return { summaryGroupCode, summaryGroupLabel };
}

export interface CategoryCreateInput {
  code: string;
  label: string;
  description: string | null;
  appliesToOrgLevelCodes: string[];
  /** `null` on both: a tile of its own, under its own label. */
  summaryGroupCode: string | null;
  summaryGroupLabel: string | null;
}

export function checkCategoryCreate(body: unknown): CategoryCreateInput {
  const f = new Fields(body, ['code', 'label', 'description', 'appliesToOrgLevelCodes', ...SUMMARY_GROUP_FIELDS]);
  const group = summaryGroup(f, body);
  return f.done({
    code: f.code('code', true),
    label: f.text('label', CONFIG_BOUNDS.categoryLabel, true),
    description: f.note('description', CONFIG_BOUNDS.description) ?? null,
    appliesToOrgLevelCodes:
      f.codes('appliesToOrgLevelCodes', { min: 0, ...CONFIG_BOUNDS.rungs }, false) ?? [],
    summaryGroupCode: group.summaryGroupCode ?? null,
    summaryGroupLabel: group.summaryGroupLabel ?? null,
  }) as CategoryCreateInput;
}

/** No `code`: every activity, ratio and goal points at it (ADR-0006). */
export interface CategoryUpdateInput {
  label?: string;
  description?: string | null;
  appliesToOrgLevelCodes?: string[];
  summaryGroupCode?: string | null;
  summaryGroupLabel?: string | null;
}

export function checkCategoryUpdate(body: unknown): CategoryUpdateInput {
  const f = new Fields(body, ['label', 'description', 'appliesToOrgLevelCodes', ...SUMMARY_GROUP_FIELDS]);
  const group = summaryGroup(f, body);
  return f.done({
    label: f.text('label', CONFIG_BOUNDS.categoryLabel, false),
    description: f.note('description', CONFIG_BOUNDS.description),
    appliesToOrgLevelCodes: f.codes('appliesToOrgLevelCodes', { min: 0, ...CONFIG_BOUNDS.rungs }, false),
    ...group,
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

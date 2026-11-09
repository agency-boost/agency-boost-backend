import { Fields, refuseWith, type FieldSentence } from '@/common/validation/fields';
import { VALIDATION_REFUSALS } from '@/common/validation/validation.messages';
import {
  CAMPAIGN_EVALUATION_PHASE, CAMPAIGN_KINDS, comparePhases, CAMPAIGN_LIMITS, CAMPAIGN_METRICS, CAMPAIGN_POSTER_COLORS,
  CAMPAIGN_SUBTYPES, CAMPAIGN_WINDOWS, REQUIREMENT_COMPARATORS, RESERVED_CAMPAIGN_CODES, STRUCTURAL_CAMPAIGN_WINDOWS,
  isCampaignMetric, metricByKey,
  type CampaignKind, type CampaignPosterColor, type CampaignSubtype, type CampaignWindow, type RequirementComparator,
} from '@/domain/constants';
import { isWholeMonths } from '@/domain/metrics/campaign-window';
import { CAMPAIGNS_REFUSALS } from './campaigns.messages';

/** What a campaign's fields are refused with (P18.10-T5 AC-3): this module's sentences, and the shared envelope's. */
const SAY = CAMPAIGNS_REFUSALS.VALIDATION_FAILED;
const FIELD = VALIDATION_REFUSALS.VALIDATION_FAILED;

export interface CheckedRequirement {
  metricKey: string;
  comparator: RequirementComparator;
  value: number;
  unit: string;
}

export interface CheckedCampaign {
  code?: string;
  title?: string;
  description?: string;
  startsAt?: Date;
  /** `null` clears it: a structural campaign with no end (D-fields). */
  endsAt?: Date | null;
  reward?: string;
  requirements?: CheckedRequirement[];
  kind?: CampaignKind;
  subtype?: CampaignSubtype | null;
  window?: CampaignWindow;
  appliesToOrgLevelCodes?: string[];
  poster?: { emoji: string; color: CampaignPosterColor };
  blurb?: string;
}

/** A campaign whole, as stored or about to be: what `checkCampaignShape` decides across its fields. */
export interface CampaignShape {
  kind: CampaignKind;
  subtype: CampaignSubtype | null;
  window: CampaignWindow;
  startsAt: Date;
  endsAt: Date | null;
  requirements: readonly { metricKey: string }[];
  appliesToOrgLevelCodes: readonly string[];
}

/**
 * One campaign, read field by field (P5-T7).
 *
 * The rule that matters is **AC-1**: a requirement names a metric this product can compute, or it
 * is refused **saying which** and, where the metric exists but arrives later, **which phase brings
 * it**. The prototype's requirements are display strings, so a campaign could promise a reward
 * against a figure nothing ever produces and nobody would find out until somebody asked why they
 * had not qualified.
 */
export function checkCampaign(
  body: unknown,
  opts: {
    partial?: boolean;
    /**
     * The campaign's stored requirements (a PATCH): one sent back unchanged — the same metric, comparator and value —
     * **stays**, though its metric is outside the evaluable set or no longer measured (the review, item 10). Only
     * what the edit adds or changes is held to today's rules.
     */
    keep?: readonly CheckedRequirement[];
  } = {},
): CheckedCampaign {
  const required = !opts.partial;
  const source = (body ?? {}) as Record<string, unknown>;
  const f = new Fields(source, [
    'code', 'title', 'description', 'startsAt', 'endsAt', 'reward', 'requirements',
    // P18.2-T7, D-fields: what the agent's card draws.
    'kind', 'subtype', 'window', 'appliesToOrgLevelCodes', 'poster', 'blurb',
  ]);

  const code = f.code('code', required);
  const title = f.text('title', { min: 1, max: 200 }, required);
  const description = f.text('description', { min: 0, max: 2000 }, false);
  const reward = f.text('reward', { min: 0, max: 300 }, false);
  const blurb = f.text('blurb', { min: 0, max: CAMPAIGN_LIMITS.BLURB_MAX }, false);
  const kind = f.oneOf('kind', CAMPAIGN_KINDS, false);
  const window = f.oneOf('window', CAMPAIGN_WINDOWS, false);
  const subtype = source.subtype === null ? null : f.oneOf('subtype', CAMPAIGN_SUBTYPES, false);
  const rungs = f.codes('appliesToOrgLevelCodes', { min: 0, max: 20 }, false);

  // After every `Fields` read: it pushes as it goes, so a copy taken earlier drops the lot.
  const violations = [...f.violations];

  if (code !== undefined && RESERVED_CAMPAIGN_CODES.includes(code)) {
    violations.push(SAY.reservedCode({ code }));
  }
  const startsAt = instant(source.startsAt, 'startsAt', required, violations);
  // `null` is a structural campaign with no end; whether a campaign may have none is `checkCampaignShape`'s.
  const endsAt = source.endsAt === null ? null : instant(source.endsAt, 'endsAt', false, violations);
  if (startsAt && endsAt && endsAt.getTime() <= startsAt.getTime()) {
    violations.push(SAY.endsAfterStarts);
  }
  const poster = readPoster(source.poster, violations);

  const requirements = readRequirements(source.requirements, violations, opts.keep ?? []);

  if (violations.length > 0) refuseWith(violations);
  return {
    ...(code !== undefined ? { code } : {}),
    ...(title !== undefined ? { title } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(reward !== undefined ? { reward } : {}),
    ...(startsAt ? { startsAt } : {}),
    ...(endsAt !== undefined ? { endsAt } : {}),
    ...(requirements !== undefined ? { requirements } : {}),
    ...(kind !== undefined ? { kind } : {}),
    ...(subtype !== undefined ? { subtype } : {}),
    ...(window !== undefined ? { window } : {}),
    ...(rungs !== undefined ? { appliesToOrgLevelCodes: [...new Set(rungs.map((c) => c.trim().toUpperCase()))] } : {}),
    ...(poster !== undefined ? { poster } : {}),
    ...(blurb !== undefined ? { blurb } : {}),
  };
}

/**
 * **A campaign across its fields** (P18.2-T7, D-fields, D-windows) — the rules no one field can decide, over the
 * campaign as it will be stored (a patch merged onto the stored row). Every refusal is a sentence an Owner reads.
 *
 * - A seasonal campaign is dated: it has an end, its window is its dates, and it has no subtype.
 * - A structural one is a standing programme: a subtype, a calendar year or the last twelve months held, and an end
 *   only if the office gives it one.
 * - **Whole office months** where a requirement reads the monthly file: the file is a month at a time (ADR-0050), so
 *   a window of 15 August to 15 September would read two whole months and claim half of each.
 * - Its rungs are the company's (`rungCodes`), named when one is not.
 */
export function checkCampaignShape(
  campaign: CampaignShape,
  opts: {
    timezone: string;
    rungCodes: readonly string[];
    /**
     * The fields a PATCH sends, or `all` for a create. **The whole-month rule and the rungs are checked only where
     * the edit touches them** (the review, item 10): a campaign written before the rule — dates mid-month, a rung the
     * ladder has since dropped — can still have its title or its prize changed.
     */
    changed?: readonly string[] | 'all';
  },
): void {
  const changed = opts.changed ?? 'all';
  const touches = (...fields: string[]) => changed === 'all' || fields.some((f) => changed.includes(f));
  const violations: FieldSentence[] = [];
  if (campaign.kind === 'seasonal') {
    if (campaign.endsAt === null) violations.push(SAY.seasonalNeedsEnd);
    if (campaign.window !== 'campaign_dates') violations.push(SAY.seasonalWindow);
    if (campaign.subtype !== null) violations.push(SAY.subtypeOnlyStructural);
  } else {
    if (campaign.subtype === null) violations.push(SAY.structuralSubtype);
    if (!STRUCTURAL_CAMPAIGN_WINDOWS.includes(campaign.window)) {
      violations.push(SAY.structuralWindow({ windows: STRUCTURAL_CAMPAIGN_WINDOWS }));
    }
  }
  const readsFile = campaign.requirements.some((r) => metricByKey(r.metricKey)?.campaign?.source === 'file');
  if (touches('startsAt', 'endsAt', 'requirements', 'window', 'kind')
    && campaign.window === 'campaign_dates' && readsFile && campaign.endsAt !== null
    && !isWholeMonths(campaign.startsAt, campaign.endsAt, opts.timezone)) {
    violations.push(SAY.wholeMonths);
  }
  const unknown = touches('appliesToOrgLevelCodes')
    ? campaign.appliesToOrgLevelCodes.filter((code) => !opts.rungCodes.includes(code))
    : [];
  if (unknown.length > 0) {
    violations.push(SAY.notRungs({ codes: unknown }));
  }
  if (violations.length > 0) refuseWith(violations);
}

/** The card's poster: one emoji and a colour from the token palette — never a hex (D-fields). */
function readPoster(
  raw: unknown, violations: FieldSentence[],
): { emoji: string; color: CampaignPosterColor } | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    violations.push(SAY.posterNotObject);
    return undefined;
  }
  const { emoji, color, ...rest } = raw as Record<string, unknown>;
  for (const key of Object.keys(rest)) violations.push(FIELD.unknownField({ key: `poster.${key}` }));
  const text = typeof emoji === 'string' ? emoji.trim() : '';
  if (text.length < 1 || [...text].length > CAMPAIGN_LIMITS.POSTER_EMOJI_MAX || /[A-Za-z0-9<>]/.test(text)) {
    violations.push(SAY.posterEmoji);
  }
  if (!(CAMPAIGN_POSTER_COLORS as readonly unknown[]).includes(color)) {
    violations.push(SAY.posterColor({ colors: CAMPAIGN_POSTER_COLORS }));
  }
  return { emoji: text, color: color as CampaignPosterColor };
}

function instant(
  raw: unknown, field: string, required: boolean, violations: FieldSentence[],
): Date | undefined {
  if (raw === undefined) {
    if (required) violations.push(FIELD.required({ field }));
    return undefined;
  }
  const value = new Date(String(raw));
  if (Number.isNaN(value.getTime())) {
    violations.push(SAY.notADateTime({ field }));
    return undefined;
  }
  return value;
}

function readRequirements(
  raw: unknown, violations: FieldSentence[], keep: readonly CheckedRequirement[],
): CheckedRequirement[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    violations.push(SAY.requirementsNotList);
    return undefined;
  }

  const read: CheckedRequirement[] = [];
  const seen = new Set<string>();
  raw.forEach((row, index) => {
    const n = index + 1;
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      violations.push(SAY.requirementNotObject({ n }));
      return;
    }
    const r = row as Record<string, unknown>;
    const metricKey = String(r.metricKey ?? '').trim().toUpperCase();
    const comparator = String(r.comparator ?? '');

    // One requirement per figure (the review, item 9): two on one metric are one requirement stated twice, or a
    // contradiction nobody could meet, and the dialog would print two rows of one figure.
    if (seen.has(metricKey)) {
      violations.push(SAY.metricTwice({ n, name: metricByKey(metricKey)?.name ?? metricKey }));
      return;
    }
    seen.add(metricKey);

    // A stored requirement sent back unchanged stays as it was stored (item 10).
    const kept = keep.find((k) => k.metricKey === metricKey && k.comparator === comparator && k.value === Number(r.value));
    if (kept) {
      read.push({ metricKey: kept.metricKey, comparator: kept.comparator, value: kept.value, unit: kept.unit });
      return;
    }

    const metric = metricByKey(metricKey);
    if (!metric) {
      // Named, and with the alternatives: "that is not a metric" leaves somebody guessing what is.
      violations.push(SAY.notAMetric({ n, key: metricKey, keys: CAMPAIGN_METRICS.map((m) => m.key) }));
    } else if (metric.requirable === false) {
      // An office's count, not anybody's work (P13.2-T4, `LEADERS_USED`): nobody could qualify by it.
      violations.push(SAY.countsTheOffice({ n, name: metric.name }));
    } else if (comparePhases(metric.phase, CAMPAIGN_EVALUATION_PHASE) > 0) {
      // Accepting it would be a campaign nobody can ever qualify for, failing silently. The Owner
      // reads this, so it says what is true now and names no phase: a phase number is our
      // schedule, and an Owner can do nothing with it (P10.1-T2 AC-3, ADR-0062 §3).
      violations.push(SAY.notMeasuredYet({ n, name: metric.name }));
    } else if (!isCampaignMetric(metricKey)) {
      /*
       * P18.2-T8 AC-1, D-evaluable: a target, an enum, a boolean, a per-event rate or a self-declared toggle is not
       * something anybody achieves over a campaign's window. A requirement stored before the set existed stays,
       * and reads *Not measured yet*; a new one is refused, with what may be named instead.
       */
      violations.push(SAY.notACampaignMetric({ n, name: metric.name, names: CAMPAIGN_METRICS.map((m) => m.name) }));
    }

    if (!(REQUIREMENT_COMPARATORS as readonly string[]).includes(comparator)) {
      violations.push(SAY.comparatorOneOf({ n, values: REQUIREMENT_COMPARATORS }));
    }

    const value = Number(r.value);
    if (!Number.isFinite(value)) {
      violations.push(SAY.valueNotNumber({ n }));
    } else if (metric?.unit === 'idr_minor' && !Number.isInteger(value)) {
      // Money is integer minor units, never a float (invariant §9).
      violations.push(SAY.moneyWholeSen({ n, name: metric.name, value }));
    }

    if (metric && (REQUIREMENT_COMPARATORS as readonly string[]).includes(comparator)
      && Number.isFinite(value)) {
      read.push({
        metricKey,
        comparator: comparator as RequirementComparator,
        value,
        // Copied from the registry rather than taken from the caller: a client that sent its own
        // could label sen as rupiah and every screen would render the wrong number.
        unit: metric.unit,
      });
    }
  });
  return read;
}

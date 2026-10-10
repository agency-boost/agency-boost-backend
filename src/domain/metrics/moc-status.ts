import { metricByKey } from '@/domain/constants';

/**
 * `MOC_STATUS` — Maintenance of Contract (`metrics-and-definitions.md` §A.7; Phase 18, OD-22 → option 1,
 * D-moc): the unit comparison's MOC column and its dialog (`KPM_Owner.html:1248`, `:3254-3324`).
 *
 * **The rule is the company's**, of kind `moc`, read live (ADR-0026, ADR-0035): its groups, their criteria and
 * thresholds, and whether the groups are ORed — never a threshold in code. **None of the prototype's
 * derivations are ported** (`:3254-3275`, which its own comment disowns): the inputs are OD-22's stated reading
 * of the office's file, computed by the caller — `NET_APE`, the `MONTHLY2_AA` counts, `DIRECT_AB_COUNT` and
 * `MOC_PERSISTENCY` — each with the period it was read over.
 *
 * **Three answers, and the third is the point** (D-moc): a criterion whose input is not uploaded is `met: null`,
 * never ✕, and a rule that could still go either way because of one is `unknown` — the screen's *—*, with the
 * sentence saying what is missing. *Not uploaded* is a month the file does not hold, never a member's figure
 * inside a month it does: a held month's count is a count (the exit review, item 2). Logic is three-valued
 * (Kleene): in a group that needs every criterion, one ✕ fails it whatever else is unknown; in an OR, one path
 * met is enough.
 *
 * Pure: a rule and the inputs in, the verdict out.
 */

export interface MocRuleCriterion {
  metricKey: string;
  comparator: string;
  value: number;
}

/** A carrier rule of kind `moc`, as `qualificationRules` holds it. */
export interface MocRule {
  code: string;
  appliesToOrgLevelCodes: readonly string[];
  criteriaGroups: readonly { mode: string; criteria: readonly MocRuleCriterion[] }[];
  groupMode: string;
}

/** One input, read over a stated period. `null` is *not uploaded*: the file holds no month it is read over. */
export interface MocInput {
  current: number | null;
  period: string;
}

export interface MocCriterion {
  code: string;
  label: string;
  current: number | null;
  required: number;
  /** `null` while its input is not uploaded — never ✕ on a guess. */
  met: boolean | null;
  period: string;
}

export interface Moc {
  status: 'met' | 'not_met' | 'unknown';
  /** The dialog's sentence about the paths (`KPM_Owner.html:3307-3316`), verbatim. */
  path: string;
  criteria: MocCriterion[];
  /** What is not uploaded, when the status is unknown; `null` otherwise. */
  missing: string | null;
}

/** The rule that applies to a rung, by code — the first, in the company's order — or none. */
export function mocRuleFor<R extends MocRule>(rules: readonly R[], orgLevelCode: string): R | null {
  return rules.find((rule) => rule.appliesToOrgLevelCodes.includes(orgLevelCode)) ?? null;
}

function compare(value: number, comparator: string, threshold: number): boolean {
  switch (comparator) {
    case 'gte': return value >= threshold;
    case 'gt': return value > threshold;
    case 'lte': return value <= threshold;
    case 'lt': return value < threshold;
    default: return value === threshold;
  }
}

/** One criterion: decided over its input, or `null` while the input is not uploaded — never ✕ on a guess. */
export function criterionMet(input: MocInput | undefined, comparator: string, threshold: number): boolean | null {
  if (input === undefined || input.current === null) return null;
  return compare(input.current, comparator, threshold);
}

/** Three-valued AND (`all`) or OR (`any`) — Kleene's. */
export function combine(values: readonly (boolean | null)[], mode: string): boolean | null {
  if (mode === 'any') {
    if (values.includes(true)) return true;
    return values.includes(null) ? null : false;
  }
  if (values.includes(false)) return false;
  return values.includes(null) ? null : true;
}

/** The dialog's labels (`KPM_Owner.html:3302-3313`), verbatim; a criterion the prototype never drew, by its registry name. */
export function criterionLabel(metricKey: string, rule: Pick<MocRule, 'appliesToOrgLevelCodes'>): string {
  switch (metricKey) {
    case 'NET_APE': return 'Net APE';
    case 'MONTHLY2_AA': return 'Monthly2 AA';
    case 'MONTHLY2_AA_DU': return 'Monthly2 AA — DU';
    case 'MONTHLY2_AA_DG': return 'Monthly2 AA — DG';
    case 'DIRECT_AB_COUNT': return 'Direct AB (AB on AB)';
    case 'MOC_PERSISTENCY':
      return rule.appliesToOrgLevelCodes.includes('AB') ? 'Rolling Persistency — DU/DG' : 'Rolling Persistency — DU';
    default: return metricByKey(metricKey)?.name ?? metricKey;
  }
}

const COUNT_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];

/**
 * The path sentence (`KPM_Owner.html:3307-3316`). An OR of groups is the AB's shape: met by the first group is
 * *the standard three-criteria path*, by a later one *the Direct AB (AB on AB) override path*, and otherwise
 * what it needs, the override's threshold from the rule. A single group is the AAB's: no alternate path.
 */
function pathOf(rule: MocRule, groupResults: readonly (boolean | null)[], met: boolean | null): string {
  if (rule.criteriaGroups.length > 1 && rule.groupMode === 'any') {
    if (met === true) {
      return groupResults[0] === true
        ? 'Met via the standard three-criteria path.'
        : 'Met via the Direct AB (AB on AB) override path.';
    }
    const override = rule.criteriaGroups.slice(1).flatMap((group) => group.criteria);
    const reach = override.find((c) => c.metricKey === 'DIRECT_AB_COUNT') ?? override[0];
    return `Needs to clear either the three standard criteria together, or reach ${reach.value} Direct ABs.`;
  }
  const count = rule.criteriaGroups.reduce((n, group) => n + group.criteria.length, 0);
  const rung = rule.appliesToOrgLevelCodes[0] ?? 'These';
  return `${rung} requirements have no alternate path — all ${COUNT_WORDS[count] ?? String(count)} must be met.`;
}

export function mocStatus(rule: MocRule, inputs: Readonly<Record<string, MocInput>>): Moc {
  const alternative = rule.groupMode === 'any';
  const groupResults: (boolean | null)[] = [];
  const criteria: MocCriterion[] = [];
  rule.criteriaGroups.forEach((group, index) => {
    const results = group.criteria.map((c) => {
      const input = inputs[c.metricKey];
      const met = criterionMet(input, c.comparator, c.value);
      criteria.push({
        code: c.metricKey,
        label: `${alternative && index > 0 ? '— OR — ' : ''}${criterionLabel(c.metricKey, rule)}`,
        current: input?.current ?? null,
        required: c.value,
        met,
        period: input?.period ?? '',
      });
      return met;
    });
    groupResults.push(combine(results, group.mode));
  });
  const met = combine(groupResults, rule.groupMode);
  const unknown = criteria.filter((c) => c.met === null).map((c) => criterionLabel(c.code, rule));
  return {
    status: met === true ? 'met' : met === false ? 'not_met' : 'unknown',
    path: pathOf(rule, groupResults, met),
    criteria,
    missing: met === null ? `Not uploaded yet: ${[...new Set(unknown)].join(', ')}.` : null,
  };
}

const SYMBOLS: Readonly<Record<string, string>> = { gte: '≥', gt: '>', lte: '≤', lt: '<' };

/** A threshold as the column's tooltip writes it: *Rp200M*, *75%*, *5*. */
function thresholdText(metricKey: string, value: number): string {
  switch (metricByKey(metricKey)?.unit) {
    case 'idr_minor': return `Rp${Number((value / 100 / 1_000_000).toFixed(2))}M`;
    case 'percentage': return `${value}%`;
    default: return String(value);
  }
}

/** A criterion as the tooltip names it: the dialog's label without its dash (*Rolling Persistency DU*). */
function tooltipLabel(metricKey: string, rule: Pick<MocRule, 'appliesToOrgLevelCodes'>): string {
  return criterionLabel(metricKey, rule).replace(' — ', ' ');
}

/** One group's criteria, ANDed — the two Monthly2 AA counts side by side as one (*"Monthly2 AA DU ≥ 4 / DG ≥ 6"*). */
function groupText(rule: MocRule, criteria: readonly MocRuleCriterion[]): string {
  const parts: string[] = [];
  criteria.forEach((c, i) => {
    const text = `${tooltipLabel(c.metricKey, rule)} ${SYMBOLS[c.comparator] ?? '='} ${thresholdText(c.metricKey, c.value)}`;
    const before = criteria[i - 1];
    if (c.metricKey === 'MONTHLY2_AA_DG' && before?.metricKey === 'MONTHLY2_AA_DU') {
      parts[parts.length - 1] += ` / DG ${SYMBOLS[c.comparator] ?? '='} ${thresholdText(c.metricKey, c.value)}`;
    } else {
      parts.push(text);
    }
  });
  return parts.join(' AND ');
}

/**
 * **The MOC column's tooltip** (`KPM_Owner.html:1248`), composed from the company's `moc` rules rather than
 * typed (item 8 of the Phase 18 exit review): a line per rule, in the order given — *"AAB: Net APE ≥ Rp200M AND
 * Monthly2 AA ≥ 2 AND Rolling Persistency DU ≥ 75%."* — an OR of groups with each group of several criteria in
 * brackets, as the prototype writes the AB's. A carrier that changes a threshold changes the sentence with it.
 * No rule, no sentence: `''`.
 */
export function mocRulesText(rules: readonly MocRule[]): string {
  return rules
    .filter((rule) => rule.criteriaGroups.some((group) => group.criteria.length > 0))
    .map((rule) => {
      const groups = rule.criteriaGroups.filter((group) => group.criteria.length > 0);
      const body = groups.length === 1
        ? groupText(rule, groups[0].criteria)
        : groups
          .map((group) => (group.criteria.length > 1 ? `(${groupText(rule, group.criteria)})` : groupText(rule, group.criteria)))
          .join(rule.groupMode === 'any' ? ' OR ' : ' AND ');
      return `${rule.appliesToOrgLevelCodes.join('/')}: ${body}.`;
    })
    .join('\n');
}

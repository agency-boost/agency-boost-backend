import { ACTIVATION, PERFORMANCE, RATIO_BENCHMARKS, SUMMARY, TIME } from '@/domain/constants';

/**
 * The metric registry (P4-T4) — one definition per metric, and one place to find it.
 *
 * **This exists because the prototypes carry three conflicting definitions of "active
 * agent"** and nothing said which was right. `domain-invariants.md` §8 makes that a bug
 * class rather than an accident: a screen needing a variant registers a **new named
 * metric**, it does not reinterpret an existing one locally.
 *
 * Every entry mirrors a section of `metrics-and-definitions.md`, which carries the formula,
 * the prototype citation and the reasoning. This file carries what *code* needs: the id, the
 * period it is computed over, what it answers with, and the threshold — read from
 * `domain/constants`, never restated, because invariant §7 says a number lives once.
 *
 * **Most of these cannot be computed yet**, and that is deliberate rather than premature.
 * `MONTHLY_ACTIVE_AGENT` needs the production upload (Phase 9); `COACHED_7D` needs coaching
 * sessions (Phase 13). Declaring them now means the phase that builds one binds to a
 * definition already agreed, instead of inventing a fourth "active agent" and discovering
 * the conflict in review.
 */

/** What a metric is computed over. Never mixed: a rolling window is not a calendar month. */
export type MetricPeriod =
  | 'CALENDAR_MONTH'
  | 'CALENDAR_YEAR'
  | 'ROLLING_7D'
  | 'ROLLING_30D'
  | 'ROLLING_12M'
  | 'POINT_IN_TIME'
  | 'PROGRAMME_WINDOW';

/** What it answers with. `tri_state` is boolean-or-unknown, and the unknown is load-bearing. */
export type MetricUnit =
  | 'boolean'
  | 'tri_state'
  | 'count'
  | 'ratio'
  | 'percentage'
  | 'money_minor'
  | 'days'
  | 'status';

export interface MetricDefinition {
  readonly id: string;
  readonly label: string;
  readonly period: MetricPeriod;
  readonly unit: MetricUnit;
  /**
   * The number the metric is judged against, from `domain/constants`.
   *
   * `null` where there is no threshold — a count has nothing to be compared to. Never a
   * literal: a benchmark restated here would be a second source for it (invariant §7).
   */
  readonly threshold: number | null;
  /** The earliest phase whose data makes this computable. Documentation, and honest. */
  readonly availableFrom: number;
}

/**
 * Exported for its own test. The duplicate-id throw is the one thing this registry exists
 * to prevent (§8), and it fires at module load — so the only way to assert it is to build
 * a second registry from a fixture. A rule whose enforcement is untested is a rule that
 * has never been shown to work.
 */
export function define(entries: readonly MetricDefinition[]): ReadonlyMap<string, MetricDefinition> {
  const map = new Map<string, MetricDefinition>();
  for (const entry of entries) {
    if (map.has(entry.id)) {
      // The one thing this registry exists to prevent, caught at module load rather than
      // by whichever screen happened to read the second copy.
      throw new Error(`Metric ${entry.id} is defined twice. One definition per metric.`);
    }
    map.set(entry.id, entry);
  }
  return map;
}

export const METRIC_REGISTRY = define([
  // ---- Production and activity ----
  {
    id: 'MONTHLY_ACTIVE_AGENT',
    label: 'Monthly Active Agent',
    period: 'CALENDAR_MONTH',
    // Tri-state, and the third state is the point: `null` means "no production uploaded
    // for this month", which is not `false`. An office that has not uploaded September
    // must show an em dash, never "0 active agents".
    //
    // D1 of the four readings, chosen by ADR-0054 (OD-21) and computed in one place:
    // `monthly-active-agent.ts`. No threshold — *above zero* is the definition, not a
    // benchmark an office could move. The carrier's "Monthly2 AA" is OD-22's, not this.
    unit: 'tri_state',
    threshold: null,
    availableFrom: 9,
  },
  {
    id: 'MAA_COUNT_IN_UNIT',
    label: 'Active agents in a unit',
    period: 'CALENDAR_MONTH',
    unit: 'count',
    threshold: null,
    availableFrom: 9,
  },
  {
    id: 'PACING_TO_MAA',
    label: 'Pacing to Monthly Active Agent',
    period: 'CALENDAR_MONTH',
    unit: 'boolean',
    threshold: null,
    availableFrom: 8,
  },
  {
    id: 'ACTIVITY_COMPLIANCE_7D',
    label: 'Logged activity in the last 7 days',
    period: 'ROLLING_7D',
    unit: 'boolean',
    threshold: PERFORMANCE.COMPLIANCE_WINDOW_DAYS,
    availableFrom: 6,
  },
  {
    id: 'ACTIVITY_COMPLIANCE_MONTH',
    label: 'Logged activity this month',
    period: 'CALENDAR_MONTH',
    unit: 'boolean',
    threshold: null,
    availableFrom: 6,
  },
  {
    id: 'ACTIVITY_COMPLIANCE_RATE',
    label: 'Activity-logging compliance rate',
    period: 'ROLLING_7D',
    unit: 'percentage',
    threshold: null,
    availableFrom: 6,
  },
  {
    id: 'ACTIVITY_TOTAL_BY_CATEGORY',
    label: 'Logged touches by category',
    period: 'ROLLING_30D',
    unit: 'count',
    threshold: null,
    availableFrom: 6,
  },

  // ---- Coaching ----
  {
    id: 'DAYS_SINCE_LAST_COACHING',
    label: 'Days since last 1:1',
    period: 'POINT_IN_TIME',
    unit: 'days',
    threshold: PERFORMANCE.COACHING_OVERDUE_DAYS,
    availableFrom: 13,
  },
  {
    id: 'COACHED_7D',
    label: 'Coached in the last 7 days',
    period: 'ROLLING_7D',
    unit: 'boolean',
    threshold: PERFORMANCE.COACHING_OVERDUE_DAYS,
    availableFrom: 13,
  },
  {
    id: 'COACHING_COVERAGE',
    label: 'Coaching coverage',
    period: 'ROLLING_7D',
    unit: 'percentage',
    threshold: null,
    availableFrom: 13,
  },
  {
    id: 'LEADER_COACHING_FREQUENCY',
    label: 'AB / AAB coaching frequency',
    period: 'ROLLING_30D',
    unit: 'count',
    threshold: null,
    availableFrom: 13,
  },

  // ---- Goals and production ----
  { id: 'APE_TARGET', label: 'APE target', period: 'CALENDAR_YEAR', unit: 'money_minor', threshold: null, availableFrom: 7 },
  { id: 'APE_ACHIEVED', label: 'APE achieved', period: 'CALENDAR_YEAR', unit: 'money_minor', threshold: null, availableFrom: 9 },
  {
    id: 'APE_ATTAINMENT_PCT',
    label: 'APE achieved vs target',
    period: 'CALENDAR_YEAR',
    unit: 'percentage',
    // Displayed capped, so the cap belongs to the definition rather than to a formatter.
    threshold: PERFORMANCE.ATTAINMENT_PCT_CAP,
    availableFrom: 9,
  },
  { id: 'APE_GAP_TO_TARGET', label: 'Gap to target', period: 'CALENDAR_YEAR', unit: 'money_minor', threshold: null, availableFrom: 9 },
  { id: 'POLICIES_NEEDED', label: 'Policies still needed', period: 'CALENDAR_YEAR', unit: 'count', threshold: null, availableFrom: 9 },

  /*
   * ---- The goal cascade's three targets (P8-T5) ----
   *
   * **`POINT_IN_TIME`, not `CALENDAR_MONTH`.** They are *this month's* numbers, and they change
   * every day: `monthsLeft` shrinks, so what is left to do per month grows. A period of
   * `CALENDAR_MONTH` would say the figure belongs to a month and holds for it, which is the
   * misreading that had a plan agreed in January still claiming eleven months left in October.
   *
   * **Registered after P8-T3 had already served them**, which is the rule P7-T6 applied to leads
   * three days earlier: a number in a DTO the registry does not define is a second definition of
   * the product's own vocabulary (invariant §8). `registry.spec.ts` is what caught it.
   *
   * `MONTHS_LEFT_IN_YEAR` is **not** here: it was already registered below, and the document's table
   * was what lacked a row for it. The duplicate this file refuses at module load is what said so.
   */
  /*
   * ---- The two conversion assumptions, measured (ADR-0055, P10-T9) ----
   *
   * Goal Settings prints each under the field it measures. Over the goal's own cascade codes, not the
   * office's ratios — those an office redefines and benchmarks (ADR-0024); these follow the field. No
   * threshold: the agent's own assumption is the comparison, and nothing is judged.
   */
  { id: 'MEASURED_LEAD_TO_APPOINTMENT_RATE', label: 'Your logged leads-to-appointment rate', period: 'ROLLING_30D', unit: 'ratio', threshold: null, availableFrom: 10 },
  { id: 'MEASURED_CLOSING_RATE', label: 'Your logged closing rate', period: 'ROLLING_30D', unit: 'ratio', threshold: null, availableFrom: 10 },
  /*
   * ---- The Personal Summary (P10-T4, ADR-0056, ADR-0057) ----
   *
   * `MONTHLY_APE_TARGET` is **not** the cascade's `POINT_IN_TIME` monthly figure: it is taken from the
   * year to date through last month, so this month's own upload cannot shrink this month's target.
   */
  { id: 'MONTHLY_APE_TARGET', label: 'This month’s APE target', period: 'CALENDAR_MONTH', unit: 'money_minor', threshold: null, availableFrom: 10 },
  { id: 'PROJECTED_CLOSINGS_THIS_MONTH', label: 'Closings at your current pace', period: 'CALENDAR_MONTH', unit: 'count', threshold: SUMMARY.PACE_MIN_DAYS, availableFrom: 10 },
  { id: 'CLOSINGS_NEEDED_PER_WEEK', label: 'Closings needed per week', period: 'CALENDAR_MONTH', unit: 'count', threshold: null, availableFrom: 10 },
  { id: 'POLICY_COUNT_TARGET', label: 'Policies to close this month', period: 'POINT_IN_TIME', unit: 'count', threshold: null, availableFrom: 8 },
  { id: 'APPOINTMENT_TARGET', label: 'Appointments to hold this month', period: 'POINT_IN_TIME', unit: 'count', threshold: null, availableFrom: 8 },
  { id: 'LEAD_TARGET', label: 'Leads to contact this month', period: 'POINT_IN_TIME', unit: 'count', threshold: null, availableFrom: 8 },
  {
    id: 'GOAL_PACE_STATUS',
    label: 'On track',
    period: 'CALENDAR_YEAR',
    unit: 'status',
    threshold: PERFORMANCE.ON_TRACK_PACE_THRESHOLD,
    availableFrom: 7,
  },
  {
    id: 'MONTHS_LEFT_IN_YEAR',
    label: 'Months left in the year',
    period: 'CALENDAR_YEAR',
    unit: 'ratio',
    // Clamped, so the cascade never divides by ~0 in the last days of December.
    threshold: TIME.MONTHS_PER_YEAR,
    availableFrom: 7,
  },

  // ---- Ratios. The benchmarks are the office's own; these are the platform defaults. ----
  { id: 'SELLING_SUCCESS_RATE', label: 'Selling success rate', period: 'ROLLING_30D', unit: 'ratio', threshold: RATIO_BENCHMARKS.SELLING_SUCCESS_RATE, availableFrom: 6 },
  { id: 'RECRUITMENT_SUCCESS_RATE', label: 'Recruitment success rate', period: 'ROLLING_30D', unit: 'ratio', threshold: RATIO_BENCHMARKS.RECRUITMENT_SUCCESS_RATE, availableFrom: 6 },
  { id: 'LEADS_PER_ACTIVITY', label: 'Leads per activity', period: 'ROLLING_30D', unit: 'ratio', threshold: RATIO_BENCHMARKS.LEADS_PER_ACTIVITY, availableFrom: 6 },
  { id: 'MEETING_PER_APPROACH', label: 'Meeting per approach', period: 'ROLLING_30D', unit: 'ratio', threshold: RATIO_BENCHMARKS.MEETING_PER_APPROACH, availableFrom: 6 },
  { id: 'SELLING_RECRUITMENT_BALANCE', label: 'Selling vs Recruitment balance', period: 'ROLLING_30D', unit: 'percentage', threshold: RATIO_BENCHMARKS.BALANCE_BAND_PP, availableFrom: 6 },

  // ---- Activation, training, events, campaigns ----
  { id: 'ACTIVATION_COMPLETION_PCT', label: '90-day activation completion', period: 'PROGRAMME_WINDOW', unit: 'percentage', threshold: null, availableFrom: 11 },
  { id: 'ACTIVATION_DAY_INDEX', label: 'Activation day', period: 'PROGRAMME_WINDOW', unit: 'days', threshold: ACTIVATION.WINDOW_DAYS, availableFrom: 11 },
  { id: 'TRAINING_COMPLETION_PCT', label: 'Training completion', period: 'POINT_IN_TIME', unit: 'percentage', threshold: null, availableFrom: 10 },
  { id: 'EVENT_ATTENDANCE_STATUS', label: 'Event attendance', period: 'POINT_IN_TIME', unit: 'status', threshold: null, availableFrom: 12 },
  { id: 'EVENT_ATTENDANCE_RATE', label: 'Event attendance rate', period: 'POINT_IN_TIME', unit: 'percentage', threshold: null, availableFrom: 12 },
  { id: 'EVENT_NPS', label: 'Event Net Promoter Score', period: 'POINT_IN_TIME', unit: 'count', threshold: null, availableFrom: 12 },
  { id: 'CAMPAIGN_QUALIFICATION_STATUS', label: 'Campaign qualification', period: 'CALENDAR_MONTH', unit: 'status', threshold: null, availableFrom: 12 },

  // ---- Carrier contract ----
  { id: 'MOC_STATUS', label: 'Maintenance of Contract', period: 'ROLLING_12M', unit: 'status', threshold: null, availableFrom: 14 },
  { id: 'PRODUCTION_CLUB_TIER', label: 'Production club tier', period: 'CALENDAR_YEAR', unit: 'status', threshold: null, availableFrom: 14 },
  { id: 'RECRUITMENT_PIPELINE_NOW', label: 'Recruitment pipeline', period: 'POINT_IN_TIME', unit: 'count', threshold: null, availableFrom: 8 },
  { id: 'RECRUITMENT_EXPECTED_TO_CLOSE', label: 'Expected to close', period: 'CALENDAR_MONTH', unit: 'count', threshold: null, availableFrom: 8 },
  { id: 'NEW_ACTIVE_AGENTS', label: 'New active agents', period: 'CALENDAR_MONTH', unit: 'count', threshold: null, availableFrom: 9 },
  { id: 'ROLLING_PERSISTENCY', label: 'Rolling persistency', period: 'ROLLING_12M', unit: 'percentage', threshold: null, availableFrom: 14 },
]);

/**
 * One metric, by id.
 *
 * Throws rather than returning `undefined`: a caller asking for a metric that is not
 * registered has invented one, and that is the thing invariant §8 forbids. Failing at the
 * call site names it; an `undefined` would surface three layers away as a blank card.
 */
export function metric(id: string): MetricDefinition {
  const found = METRIC_REGISTRY.get(id);
  if (!found) {
    throw new Error(
      `No metric called ${id}. A screen needing a variant registers a new named metric in `
        + 'domain/metrics/registry.ts and documents it in metrics-and-definitions.md — it '
        + 'does not reinterpret an existing one locally (domain-invariants.md §8).',
    );
  }
  return found;
}

export const METRIC_IDS: readonly string[] = [...METRIC_REGISTRY.keys()];

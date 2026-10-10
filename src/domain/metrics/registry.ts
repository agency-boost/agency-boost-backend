import { ACTIVATION, PERFORMANCE, RATIO_BENCHMARKS, TIME } from '@/domain/constants';
import { METRIC_REGISTRY as SERVED, type MetricUnit } from '@/domain/constants/metrics';

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
 * sessions (Phase 11 — the old plan's 13, moved by the 2026-09-29 crosswalk in P10.1-T2 AC-6).
 * Declaring them now means the phase that builds one binds to a
 * definition already agreed, instead of inventing a fourth "active agent" and discovering
 * the conflict in review.
 *
 * **What a metric is called, what it answers with and the phase that computes it live once**, in
 * `domain/constants/metrics.ts` — the list `GET /metrics` serves (P10-T8). This file adds what a
 * computation needs and that list does not: the period and the threshold.
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

export type { MetricUnit };

export interface MetricDefinition {
  readonly id: string;
  /** The served name. */
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
  /**
   * The phase that first computes it for real — the served list's, and the document's index.
   *
   * This was `availableFrom`, *the earliest phase whose data makes it computable*, beside a served
   * `phase` meaning the other thing: `PACING_TO_MAA` was 8 here and 13 there (the old plan's
   * coaching phase; 11 since P10.1-T2 AC-6), and a campaign asking which is true got the answer
   * from whichever list it happened to read.
   */
  readonly phase: number;
}

/** What a computation needs beyond the served entry. */
export interface MetricComputation {
  readonly period: MetricPeriod;
  readonly threshold: number | null;
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

/**
 * **The served list and the computations, joined — or refused** (P10-T8). A served metric with no
 * period, or a period for a metric nobody serves, is two registries drifting apart again; either
 * throws at load, naming the metric. Exported so the refusal itself is tested.
 */
export function join(
  served: readonly { key: string; name: string; unit: MetricUnit; phase: number }[],
  computations: Readonly<Record<string, MetricComputation>>,
): MetricDefinition[] {
  const keys = new Set(served.map((m) => m.key));
  const orphan = Object.keys(computations).find((id) => !keys.has(id));
  if (orphan) {
    throw new Error(`Metric ${orphan} has a period here and no entry in domain/constants/metrics.ts. One list.`);
  }
  return served.map((m) => {
    const how = computations[m.key];
    if (!how) {
      throw new Error(`Metric ${m.key} is served with no period or threshold in domain/metrics/registry.ts.`);
    }
    return { id: m.key, label: m.name, unit: m.unit, phase: m.phase, ...how };
  });
}

/** Each metric's period and threshold, by id — the only thing this file says that the served list does not. */
const COMPUTATIONS: Record<string, MetricComputation> = {
  // ---- Production and activity ----
  /*
   * Tri-state, and the third state is the point: `null` means "no production uploaded for this
   * month", which is not `false`. An office that has not uploaded September must show an em dash,
   * never "0 active agents".
   *
   * D1 of the four readings, chosen by ADR-0054 (OD-21) and computed in one place:
   * `monthly-active-agent.ts`. No threshold — *above zero* is the definition, not a benchmark an
   * office could move. The carrier's "Monthly2 AA" is OD-22's, not this.
   */
  MONTHLY_ACTIVE_AGENT: { period: 'CALENDAR_MONTH', threshold: null },
  MAA_COUNT_IN_UNIT: { period: 'CALENDAR_MONTH', threshold: null },
  // The gate is a policy count, fixed (§B.4): computed in `domain/metrics/pacing-to-maa.ts` (P11-T6).
  PACING_TO_MAA: { period: 'CALENDAR_MONTH', threshold: PERFORMANCE.MAA_PROJECTED_SUBMISSIONS_MIN },
  ACTIVITY_COMPLIANCE_7D: { period: 'ROLLING_7D', threshold: PERFORMANCE.COMPLIANCE_WINDOW_DAYS },
  ACTIVITY_COMPLIANCE_MONTH: { period: 'CALENDAR_MONTH', threshold: null },
  ACTIVITY_COMPLIANCE_RATE: { period: 'ROLLING_7D', threshold: null },
  ACTIVITY_TOTAL_BY_CATEGORY: { period: 'ROLLING_30D', threshold: null },

  // ---- Coaching ----
  DAYS_SINCE_LAST_COACHING: { period: 'POINT_IN_TIME', threshold: PERFORMANCE.COACHING_OVERDUE_DAYS },
  COACHED_7D: { period: 'ROLLING_7D', threshold: PERFORMANCE.COACHING_OVERDUE_DAYS },
  // Served since Phase 5 and absent here until P10-T8 compared the two lists.
  COACHED_30D: { period: 'ROLLING_30D', threshold: null },
  COACHING_COVERAGE: { period: 'ROLLING_7D', threshold: null },
  /*
   * The Overview's leaderboard reads it over `ROLLING_7D` (§A.3, `KPM_Owner.html:1024-1042`, D-coverage). It
   * read `ROLLING_30D` here until P18-T1, the first task to compute it. `leader-coaching-frequency.ts`.
   */
  LEADER_COACHING_FREQUENCY: { period: 'ROLLING_7D', threshold: null },

  // ---- Goals and production ----
  APE_TARGET: { period: 'CALENDAR_YEAR', threshold: null },
  APE_ACHIEVED: { period: 'CALENDAR_YEAR', threshold: null },
  // Displayed capped, so the cap belongs to the definition rather than to a formatter.
  APE_ATTAINMENT_PCT: { period: 'CALENDAR_YEAR', threshold: PERFORMANCE.ATTAINMENT_PCT_CAP },
  APE_GAP_TO_TARGET: { period: 'CALENDAR_YEAR', threshold: null },
  POLICIES_NEEDED: { period: 'CALENDAR_YEAR', threshold: null },

  /*
   * ---- The goal cascade's three targets (P8-T5) ----
   *
   * **`POINT_IN_TIME`, not `CALENDAR_MONTH`.** They are *this month's* numbers, and they change
   * every day: `monthsLeft` shrinks, so what is left to do per month grows. A period of
   * `CALENDAR_MONTH` would say the figure belongs to a month and holds for it, which is the
   * misreading that had a plan agreed in January still claiming eleven months left in October.
   */
  POLICY_COUNT_TARGET: { period: 'POINT_IN_TIME', threshold: null },
  APPOINTMENT_TARGET: { period: 'POINT_IN_TIME', threshold: null },
  LEAD_TARGET: { period: 'POINT_IN_TIME', threshold: null },
  // Clamped, so the cascade never divides by ~0 in the last days of December.
  MONTHS_LEFT_IN_YEAR: { period: 'CALENDAR_YEAR', threshold: TIME.MONTHS_PER_YEAR },
  /*
   * **The calendar month, as the definition and the prototype's tooltip say** (ADR-0080): this month's
   * APE against this month's target, after the MAA gate. It read `CALENDAR_YEAR` until P11-T6, the
   * first task to compute it — the stale half the document named. Computed in
   * `domain/metrics/goal-pace-status.ts`.
   */
  GOAL_PACE_STATUS: { period: 'CALENDAR_MONTH', threshold: PERFORMANCE.ON_TRACK_PACE_THRESHOLD },

  /*
   * ---- The two conversion assumptions, measured (ADR-0055, P10-T9) ----
   *
   * Goal Settings prints each under the field it measures. Over the goal's own cascade codes, not the
   * office's ratios — those an office redefines and benchmarks (ADR-0024); these follow the field. No
   * threshold: the agent's own assumption is the comparison, and nothing is judged.
   */
  MEASURED_LEAD_TO_APPOINTMENT_RATE: { period: 'ROLLING_30D', threshold: null },
  MEASURED_CLOSING_RATE: { period: 'ROLLING_30D', threshold: null },

  /*
   * ---- The Personal Summary (P10-T4, ADR-0056, ADR-0109) ----
   *
   * `MONTHLY_APE_TARGET` is **not** the cascade's `POINT_IN_TIME` monthly figure: it is taken from the
   * year to date before this month, so this month's own upload cannot shrink this month's target.
   *
   * The pace sentence (ADR-0109, superseding ADR-0057): *tracking to close N* is the closings of the last
   * `SUMMARY.PACE_WINDOW_DAYS`, today included — a rolling window, never the calendar month, and with no
   * first day before which it says nothing. The needed pace is this month's.
   */
  MONTHLY_APE_TARGET: { period: 'CALENDAR_MONTH', threshold: null },
  CLOSINGS_LAST_30_DAYS: { period: 'ROLLING_30D', threshold: null },
  CLOSINGS_NEEDED_PER_WEEK: { period: 'CALENDAR_MONTH', threshold: null },
  /*
   * The Summary's activity chips (P10-T5, ADR-0056): the cascade run on `MONTHLY_APE_TARGET` for the
   * month, and on the annual target for the year to date. `CALENDAR_MONTH` is the default view; the
   * *Yearly* view is the same definition over `CALENDAR_YEAR`.
   */
  SUMMARY_ACTIVITY_TARGET: { period: 'CALENDAR_MONTH', threshold: null },
  // Capped like APE_ATTAINMENT_PCT, and `null` on a zero target — never `NaN%` (F-25).
  ACTIVITY_TARGET_ATTAINMENT_PCT: { period: 'CALENDAR_MONTH', threshold: PERFORMANCE.ATTAINMENT_PCT_CAP },
  /*
   * The coaching session's Activity card (P11-T4): this month's `SUMMARY_ACTIVITY_TARGET` pro-rated to
   * `ROLLING_7D` by `SUB_PERIOD.TARGET_SCALING`, closings floored. Computed in
   * `domain/metrics/sub-period-activity-target.ts`. No threshold: a count, and the floor is part of the
   * formula, not a benchmark it is judged against.
   */
  SUB_PERIOD_ACTIVITY_TARGET: { period: 'ROLLING_7D', threshold: null },

  // ---- Ratios. The benchmarks are the office's own; these are the platform defaults. ----
  SELLING_SUCCESS_RATE: { period: 'ROLLING_30D', threshold: RATIO_BENCHMARKS.SELLING_SUCCESS_RATE },
  RECRUITMENT_SUCCESS_RATE: { period: 'ROLLING_30D', threshold: RATIO_BENCHMARKS.RECRUITMENT_SUCCESS_RATE },
  LEADS_PER_ACTIVITY: { period: 'ROLLING_30D', threshold: RATIO_BENCHMARKS.LEADS_PER_ACTIVITY },
  MEETING_PER_APPROACH: { period: 'ROLLING_30D', threshold: RATIO_BENCHMARKS.MEETING_PER_APPROACH },
  SELLING_RECRUITMENT_BALANCE: { period: 'ROLLING_30D', threshold: RATIO_BENCHMARKS.BALANCE_BAND_PP },

  // ---- Activation, training, events, campaigns ----
  ACTIVATION_COMPLETION_PCT: { period: 'PROGRAMME_WINDOW', threshold: null },
  ACTIVATION_DAY_INDEX: { period: 'PROGRAMME_WINDOW', threshold: ACTIVATION.WINDOW_DAYS },
  TRAINING_COMPLETION_PCT: { period: 'POINT_IN_TIME', threshold: null },
  EVENT_ATTENDANCE_STATUS: { period: 'POINT_IN_TIME', threshold: null },
  EVENT_ATTENDANCE_RATE: { period: 'POINT_IN_TIME', threshold: null },
  EVENT_NPS: { period: 'POINT_IN_TIME', threshold: null },
  CAMPAIGN_QUALIFICATION_STATUS: { period: 'CALENDAR_MONTH', threshold: null },

  // ---- Carrier contract ----
  MOC_STATUS: { period: 'ROLLING_12M', threshold: null },
  PRODUCTION_CLUB_TIER: { period: 'CALENDAR_YEAR', threshold: null },
  RECRUITMENT_PIPELINE_NOW: { period: 'POINT_IN_TIME', threshold: null },
  RECRUITMENT_EXPECTED_TO_CLOSE: { period: 'CALENDAR_MONTH', threshold: null },

  // ---- The Unit Dashboard (Phase 15, D-leads, D-metrics) ----
  /*
   * A lead's state now, and this office month's promises (P7-T5), whatever period the screen shows.
   * Counted per person in `domain/metrics/lead-counts.ts`, summed by the rollup rule.
   */
  OPEN_SALES_LEADS: { period: 'POINT_IN_TIME', threshold: null },
  SALES_LEADS_CLOSING_THIS_MONTH: { period: 'CALENDAR_MONTH', threshold: null },
  RECRUITMENT_NOMINATED_THIS_MONTH: { period: 'CALENDAR_MONTH', threshold: null },
  /*
   * `PACING_TO_MAA` counted over a group, so its period is that metric's. No threshold of its own: the
   * gate is `PACING_TO_MAA`'s. Computed in `domain/metrics/unit-rollup.ts`.
   */
  POTENTIAL_MAA_COUNT_IN_UNIT: { period: 'CALENDAR_MONTH', threshold: null },
  /*
   * The goal's three cascade codes logged against their summed targets, over the period the screen shows:
   * the calendar month by default, `ROLLING_7D` and the year to date as its other views, as
   * `SUMMARY_ACTIVITY_TARGET`'s *Yearly* view is the same definition. Computed in `unit-rollup.ts`.
   */
  CASCADE_ACTIVITY_TOUCHES: { period: 'CALENDAR_MONTH', threshold: null },
  NEW_ACTIVE_AGENTS: { period: 'CALENDAR_MONTH', threshold: null },
  ROLLING_PERSISTENCY: { period: 'ROLLING_12M', threshold: null },

  // ---- The office (P13.2-T4, ADR-0113) ----
  /*
   * The count now, at the read or the write. Its threshold is **each office's own**
   * `kpms.subscription.maxLeaders`, or none — data, not a platform constant, so `null` here (§A.9).
   * Counted by `countLeadersUsed` in `modules/org/leader-limit.ts` and nowhere else.
   */
  LEADERS_USED: { period: 'POINT_IN_TIME', threshold: null },

  // ---- The Owner's reporting (Phase 18, D-registry) ----
  /*
   * OD-24 (refined 2026-10-09): the office's active memberships on the period's last day — every rung, the
   * Owner and the Admins as the members they are; pending and removed never; a leaver until `removedAt`.
   * The one headcount every denominator reads (`office-headcount.ts`).
   */
  OFFICE_HEADCOUNT: { period: 'POINT_IN_TIME', threshold: null },
  OFFICE_NEW_MEMBERS_THIS_MONTH: { period: 'CALENDAR_MONTH', threshold: null },
  // OD-142 → option 2: `ACTIVITY_COMPLIANCE_MONTH`, counted over the office (`activity-logged.ts`).
  ACTIVITY_LOGGED_THIS_MONTH: { period: 'CALENDAR_MONTH', threshold: null },
  RECRUITMENT_CLOSED_LAST_MONTH: { period: 'CALENDAR_MONTH', threshold: null },
  // The year to date over the months it covers, run to twelve (D-figures; `ape-year-projection.ts`).
  APE_YEAR_PROJECTION: { period: 'CALENDAR_YEAR', threshold: null },
  /*
   * MOC's inputs, OD-22's stated reading (`moc-status.ts`). Their thresholds are the company's carrier rules,
   * read live (ADR-0026) — never a platform constant here — so none has one of its own.
   */
  NET_APE: { period: 'CALENDAR_YEAR', threshold: null },
  MONTHLY2_AA: { period: 'CALENDAR_MONTH', threshold: null },
  MONTHLY2_AA_DU: { period: 'CALENDAR_MONTH', threshold: null },
  MONTHLY2_AA_DG: { period: 'CALENDAR_MONTH', threshold: null },
  DIRECT_AB_COUNT: { period: 'POINT_IN_TIME', threshold: null },
  MOC_PERSISTENCY: { period: 'ROLLING_12M', threshold: null },

  // ---- The Strategic Leader Forum's scorecard (Phase 18.1, P18.1-T1; D-cohort, OD-144) ----
  /*
   * **The three rows the prototype draws over *FY* and *YTD* alone** (`KPM_Owner.html:2465`, `:2468`, `:2472`, the
   * single months blocked) are `CALENDAR_YEAR`: a year, or a year to date. The cohort is read over the same periods,
   * by its start day in the office's calendar (`activation-cohort.ts`).
   */
  ACTIVATION_COHORT: { period: 'CALENDAR_YEAR', threshold: null },
  NEW_AGENT_3M_ACTIVE_PCT: { period: 'CALENDAR_YEAR', threshold: null },
  PRODUCING_AGENTS: { period: 'CALENDAR_YEAR', threshold: null },
  AVERAGE_CASE_SIZE_REALISED: { period: 'CALENDAR_YEAR', threshold: null },
  /*
   * **The three drawn in every column** are `CALENDAR_MONTH`: each month's figure from the office's file, and over
   * *FY* or *YTD* the months held summed or averaged — the same definition over a year, as `SUMMARY_ACTIVITY_TARGET`'s
   * *Yearly* view is (`held-months.ts`).
   */
  NEW_ACTIVE_AGENTS_MONTHLY_AVG: { period: 'CALENDAR_MONTH', threshold: null },
  MAA_MONTHLY_AVG: { period: 'CALENDAR_MONTH', threshold: null },
  CASE_SUBMISSIONS: { period: 'CALENDAR_MONTH', threshold: null },
};

export const METRIC_REGISTRY = define(join(SERVED, COMPUTATIONS));

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
        + 'domain/constants/metrics.ts, gives it a period in domain/metrics/registry.ts and '
        + 'documents it in metrics-and-definitions.md — it does not reinterpret an existing one '
        + 'locally (domain-invariants.md §8).',
    );
  }
  return found;
}

export const METRIC_IDS: readonly string[] = [...METRIC_REGISTRY.keys()];

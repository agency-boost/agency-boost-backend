/**
 * The Owner's reporting (Phase 18; `functional/kpm-analytics.md`): the KPM Overview, KPM analytics and the
 * platform's adoption read. Every number here is **Fixed** (`metrics-and-definitions.md` §B), pinned by
 * `reporting.spec.ts`; the thresholds a figure is judged against are the company's carrier rules, read live,
 * never a constant (ADR-0026).
 */
export const KPM_REPORTING = {
  /** *This month* · *Previous month* (`KPM_Owner.html:1240-1245`), in the order drawn (D-period). */
  ANALYTICS_PERIODS: ['this_month', 'previous_month'] as const,
  /** *This month* is first selected (`:1242`). */
  ANALYTICS_DEFAULT_PERIOD: 'this_month' as const,
  /** *Monthly production*: the six months before this one (`:3429-3445`, T2 AC-6). */
  MONTHLY_CHART_MONTHS: 6,
  /**
   * `MONTHLY2_AA` and its DU and DG: members active in **each of the last two months held** (OD-22 → option
   * 1). Two, from the carrier's own name for it.
   */
  MONTHLY2_MONTHS: 2,
  /**
   * The attainment split the prototype colours a unit's or a leader's row by: at or above it *success*, below
   * it *alert* (`KPM_Owner.html:3150`, `:3220`). Served on both reads as `thresholds.statusSplitPct`, so no
   * screen re-declares it (invariant §7).
   */
  STATUS_SPLIT_PCT: 70,
  /**
   * *View who hasn't logged →* lists the first three and counts the rest (`KPM_Owner.html:988-1001`: three
   * rows, then *"+ 66 more — full list on the People screen"*). `GET /kpm/overview/not-logged` serves those
   * three and the total, and records a §3.5 entry for the three it discloses — never for the rest.
   */
  NOT_LOGGED_SHOWN: 3,
} as const;

export type KpmAnalyticsPeriod = (typeof KPM_REPORTING.ANALYTICS_PERIODS)[number];

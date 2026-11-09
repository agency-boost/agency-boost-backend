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
  /*
   * `MONTHLY2_MONTHS` (2) was here: `MONTHLY2_AA` read the last two months held (OD-22 → option 1). Retired by
   * P19.3-T1 (ADR-0201 §4, Q6): *Monthly2 AA* is the average over the year's months held, which has no window to fix.
   */
  /**
   * The attainment split the prototype colours a unit's or a leader's row by: at or above it *success*, below
   * it *alert* (`KPM_Owner.html:3150`, `:3220`). Served on both reads as `thresholds.statusSplitPct`, so no
   * screen re-declares it (invariant §7).
   */
  STATUS_SPLIT_PCT: 70,
  /**
   * **The compliance tiles' and rows' bars on a phone** (UI V1, UI-109; `kpm-mobile` 3): red below 50% done, green
   * from 80%, the accent between. Served on the compliance read as `thresholds`, so no screen re-declares them.
   */
  COMPLIANCE_LOW_BELOW_PCT: 50,
  COMPLIANCE_HIGH_FROM_PCT: 80,
  /**
   * *View who hasn't logged →* listed the first three and counted the rest (`KPM_Owner.html:988-1001`: three
   * rows, then *"+ 66 more — full list on the People screen"*). `GET /kpm/overview/not-logged` serves those and the
   * total, and records a §3.5 entry for each one it discloses — never for the rest.
   *
   * *Changed 2026-11-05 (P19.3-T2 AC-2; UI-148, `kpm-overview-mobile-2026-11-03` 3):* **five**, the rows the
   * *Belum mencatat · 7 hari* sheet draws before *"Semua n ›"*; the desktop card draws the first three of them.
   */
  NOT_LOGGED_SHOWN: 5,
} as const;

export type KpmAnalyticsPeriod = (typeof KPM_REPORTING.ANALYTICS_PERIODS)[number];

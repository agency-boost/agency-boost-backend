/**
 * The Owner's reporting: the KPM Overview (`functional/kpm-overview.md`) and the platform's adoption read. Every number
 * here is **Fixed** (`metrics-and-definitions.md` §B), pinned by `reporting.spec.ts`; the thresholds a figure is judged
 * against are the company's carrier rules, read live, never a constant (ADR-0026).
 *
 * *Changed 2026-11-20 (P19.19; ADR-0272):* KPM Analytics is removed (`/kpm/analytics`, its two periods and its 70% row
 * split), and with it the Overview's first version (*Belum mencatat*'s five, the recruitment target). What stays: the six
 * months of *Produksi 6 bulan*, and the compliance cards' two splits, which moved from 50 / 80 to **34 / 67**
 * (`revisions/2026-11-19/BRIEF-ADJUSTMENTS-2026-11-19.md`, §6 Compliance: *"red < 34%, yellow < 67%, green from 67%"*).
 */
export const KPM_REPORTING = {
  /** *Produksi 6 bulan* (section 6): the six months ending with the office's current one (UI-091, ADR-0272 §5). */
  MONTHLY_CHART_MONTHS: 6,
  /*
   * `MONTHLY2_MONTHS` (2) was here: `MONTHLY2_AA` read the last two months held (OD-22 → option 1). Retired by
   * P19.3-T1 (ADR-0201 §4, Q6): *Monthly2 AA* is the average over the year's months held, which has no window to fix.
   *
   * `ANALYTICS_PERIODS`, `ANALYTICS_DEFAULT_PERIOD`, `STATUS_SPLIT_PCT` (70) and `NOT_LOGGED_SHOWN` (5) were here until
   * P19.19 (ADR-0272 §1, §2): KPM Analytics' two periods and its row colour, and the first Overview's *Belum mencatat*
   * list. Nothing reads them since both pages were replaced.
   */
  /**
   * **The compliance cards' colour** (P19.19-T3 AC-2; the brief's §6): a card's % pill and its bar are **red below 34%**
   * done, **yellow below 67%**, **green from 67%**. Served on the compliance read as `thresholds`, so no screen re-declares
   * them (invariant §7). They were 50 and 80 (UI-109) until 2026-11-20.
   */
  COMPLIANCE_LOW_BELOW_PCT: 34,
  COMPLIANCE_HIGH_FROM_PCT: 67,
} as const;

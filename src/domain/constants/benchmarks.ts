/**
 * Ratio benchmarks, in their own file so the seeded ratio definitions can import them
 * without a cycle through the barrel. Still the single source (invariant §7) — `index.ts`
 * re-exports it, and `constants.spec.ts` pins every number.
 */
/**
 * Ratio benchmarks. Overall.html:5208-5273, KPM_Owner.html:1451-1490 — **raised at the client's request**
 * (ADR-0160 §2, 2026-10-26) from the prototype's 0.15, 0.15, 0.30 and 1.50. The balance band is the
 * prototype's.
 */
export const RATIO_BENCHMARKS = {
  /** Submissions ÷ (presentations + follow-ups). Overall.html:5235 (15%). Tenant-configurable. */
  SELLING_SUCCESS_RATE: 0.3,
  /** Agent codes ÷ (recruitment presentations + follow-ups). Overall.html:5247 (15%). Tenant-configurable. */
  RECRUITMENT_SUCCESS_RATE: 0.3,
  /** New prospects ÷ lead-gen activities. Overall.html:5259 (0.30). Tenant-configurable. */
  LEADS_PER_ACTIVITY: 1,
  /**
   * *Set appointment to meeting*: (sales + recruitment presentations) ÷ appointments set. Overall.html:5271
   * (1.50, as *Meeting per approach*). Shown as a percent since ADR-0160. Tenant-configurable.
   */
  MEETING_PER_APPROACH: 0.5,
  /** Selling/recruitment lean tolerance, in percentage points either side. Overall.html:5225. */
  BALANCE_BAND_PP: 30,
} as const;

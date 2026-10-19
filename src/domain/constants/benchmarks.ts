/**
 * Ratio benchmarks, in their own file so the seeded ratio definitions can import them
 * without a cycle through the barrel. Still the single source (invariant §7) — `index.ts`
 * re-exports it, and `constants.spec.ts` pins every number.
 */
/** Ratio benchmarks. Overall.html:5208-5273, KPM_Owner.html:1451-1490. */
export const RATIO_BENCHMARKS = {
  /** Submissions ÷ (presentations + follow-ups). Overall.html:5235. Tenant-configurable. */
  SELLING_SUCCESS_RATE: 0.15,
  /** Agent codes ÷ (NBO presentations + follow-ups). Overall.html:5247. Tenant-configurable. */
  RECRUITMENT_SUCCESS_RATE: 0.15,
  /** New prospects ÷ lead-gen activities. Overall.html:5259. Tenant-configurable. */
  LEADS_PER_ACTIVITY: 0.3,
  /** (Sales + recruitment presentations) ÷ prospect contacts. Overall.html:5271. */
  MEETING_PER_APPROACH: 1.5,
  /** Selling/recruitment lean tolerance, in percentage points either side. Overall.html:5225. */
  BALANCE_BAND_PP: 30,
} as const;

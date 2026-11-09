/**
 * `CASES_PER_PRODUCING_AGENT` — the forum's *Cases/producing agents*, the client's reference slide's *Productivity* row
 * (Phase 18.9, P18.9-T1 AC-5; UI-004). **Per active agent per month since P19.3-T1** (ADR-0203 §5; the data sources'
 * SLF map, *"Case issued, per active agent — per month"*; `metrics-and-definitions.md` §A.12, amended 2026-11-05).
 *
 * **Σ policies ÷ Σ monthly active agents, over the same months held** — each month's policy count over the office's file
 * (`policyCountMonthly` summed, a leaver's kept) and its `MAA_COUNT_IN_UNIT` over the office (its members on the month's
 * last day), both summed over the months of the period that hold both: the average cases per active agent per month,
 * **recomputed from the sums, never an average of monthly ratios**. It no longer divides by *Annual Active Agents*
 * (`PRODUCING_AGENTS`, the year's distinct producers), which it was until 2026-11-05: a scorecard frozen before then
 * keeps the figure it froze with (ADR-0129 §7).
 *
 * - **`'none'` over nobody** — no active agent in any month held, *—* — never a division by zero;
 * - **`null` while no month holds both halves** — *pending data*, never 0;
 * - over *Full Year* and the two *YTD* columns only: the slide leaves its *Monthly View* *Not tracked* (the caller).
 *
 * Pure; the caller reads the two figures per month and names the months either half leaves out.
 */
export interface CasesMonth {
  /** The office's policies in the month from its file; `null` where it holds none. */
  policies: number | null;
  /** `MAA_COUNT_IN_UNIT` over the office for the month; `null` where the month is not held. */
  activeAgents: number | null;
}

export function casesPerProducingAgent(months: readonly CasesMonth[]): number | 'none' | null {
  const both = months.filter((m) => m.policies !== null && m.activeAgents !== null);
  if (both.length === 0) return null;
  const active = both.reduce((sum, m) => sum + (m.activeAgents as number), 0);
  if (active === 0) return 'none';
  return both.reduce((sum, m) => sum + (m.policies as number), 0) / active;
}

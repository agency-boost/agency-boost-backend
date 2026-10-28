/**
 * `CASES_PER_PRODUCING_AGENT` (Phase 18.97, P18.97-T1 AC-5; ADR-0175 §2, OD-228) — the forum's *Cases/producing
 * agents*, the client's reference slide's new *Productivity* row (UI-004).
 *
 * **`CASE_SUBMISSIONS` ÷ `PRODUCING_AGENTS` over the same period** — the policies in the office's file over the
 * members who were a Monthly Active Agent in at least one of its months held (*Annual Active Agents*) — each read
 * through its own function, never a second rule (invariant §8). Exact: the screen writes it to one decimal (*2,4*).
 *
 * - **`'none'` over nobody** — no producing agent, *—* — never a division by zero;
 * - **`null` while either is** — *pending data*, never 0;
 * - over *Full Year* and the two *YTD* columns only: *Annual Active Agents* is not tracked in a single month, so
 *   neither is this (the caller draws those cells *Not tracked*).
 *
 * Pure; the caller reads the two figures.
 */
export function casesPerProducingAgent(cases: number | null, producing: number | null): number | 'none' | null {
  if (cases === null || producing === null) return null;
  if (producing === 0) return 'none';
  return cases / producing;
}

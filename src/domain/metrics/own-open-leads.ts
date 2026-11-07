import type { LeadCountsRow } from './unit-rollup';

/**
 * **`OWN_OPEN_LEADS` — the reader's own open leads, Sales and Recruit** (P19.8-T2; `metrics-and-definitions.md` §A.17;
 * ADR-0228 §4, OD-283 by its default): Home's *Leads* tile, the one figure an Agent and a leader both have.
 *
 * ```
 * OWN_OPEN_LEADS(m) = OPEN_SALES_LEADS(m) + RECRUITMENT_PIPELINE_NOW(m)
 * ```
 *
 * **Two registered counts over one owner, added** — never a rule of its own: a sales lead while it has no outcome, a
 * recruitment lead while it has no outcome and stands on no stage the office marks terminal (`personLeadCounts`), a
 * deleted lead no lead at all. It is the reader's own row of the Unit Dashboard's *Leads* column (*Sales n* and
 * *Recruit n*) as one number, so Home never disagrees with it.
 */
export function ownOpenLeads(counts: Pick<LeadCountsRow, 'salesOpen' | 'recruitOpen'> | undefined): number {
  if (!counts) return 0;
  return counts.salesOpen + counts.recruitOpen;
}

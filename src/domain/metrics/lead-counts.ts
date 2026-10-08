import type { LeadCountsRow } from './unit-rollup';

/**
 * **A person's lead counts on the Unit Dashboard** (Phase 15, D-leads; `metrics-and-definitions.md`,
 * `OPEN_SALES_LEADS`, `SALES_LEADS_CLOSING_THIS_MONTH`, `RECRUITMENT_PIPELINE_NOW` and
 * `RECRUITMENT_NOMINATED_THIS_MONTH`) — the *Leads* column's *Sales: {n} · {m} closing* and *Recruit: {n}
 * · {m} nominated* (`Overall.html:7371-7373`, `:7399-7403`).
 *
 * **`LeadService.summary`'s rules, per owner.** A lead is *open* while it has no outcome, a deleted one is
 * no lead at all (the repository's), and a *commitment* is the owner's promise for the office's month —
 * derived from `commitments`, never swept (P7-T5). *Still running* in recruitment is a stage the office's
 * own ladder does not mark terminal (invariant §4: codes, read from the office, never hardcoded). A lead
 * of neither type is in none of the four.
 *
 * `RECRUITMENT_PIPELINE_NOW` is `LeadService.summary`'s count, over one owner; `lead-counts.tenancy.spec.ts`
 * pins the two evaluations together on the same office, as the attention counts are pinned.
 */

/** What the four counts read of a lead. */
export interface CountedLead {
  type: 'sales' | 'recruitment' | null;
  outcome: 'won' | 'lost' | null;
  statusCode: string | null;
  commitments?: readonly { month: string }[] | null;
}

export function personLeadCounts(
  leads: readonly CountedLead[],
  office: {
    /** The office's month, `YYYY-MM`: the month a commitment is for. */
    month: string;
    /** The office's recruitment stages marked terminal. */
    terminalRecruitmentCodes: readonly string[];
  },
): LeadCountsRow {
  const open = leads.filter((lead) => lead.outcome === null);
  const committed = (lead: CountedLead) => (lead.commitments ?? []).some((c) => c.month === office.month);
  const sales = open.filter((lead) => lead.type === 'sales');
  const recruitment = open.filter((lead) => lead.type === 'recruitment');
  return {
    // OPEN_SALES_LEADS
    salesOpen: sales.length,
    // SALES_LEADS_CLOSING_THIS_MONTH
    salesClosing: sales.filter(committed).length,
    // RECRUITMENT_PIPELINE_NOW, per person
    recruitOpen: recruitment.filter((lead) => !office.terminalRecruitmentCodes.includes(lead.statusCode ?? '')).length,
    // RECRUITMENT_NOMINATED_THIS_MONTH
    recruitNominated: recruitment.filter(committed).length,
  };
}

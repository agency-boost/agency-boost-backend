/**
 * `RECRUITMENT_CLOSED_LAST_MONTH` (Phase 18, D-recruit) — the recruitment pipeline's *Last month* tile
 * (`KPM_Owner.html:1063-1065`): the recruitment leads **closed won** in the last calendar month, in the office's
 * zone. A lead is won at the stage that closes its pipeline, and the close is stamped (`outcomeAt`, P7-T3); a
 * lead closed and reopened since is not won, and counts nowhere. A count, never a list (roles §3.6).
 */
export interface ClosedLead {
  type: 'sales' | 'recruitment' | null;
  outcome: 'won' | 'lost' | null;
  outcomeAt: Date | null;
}

export function recruitmentClosedIn(
  leads: readonly ClosedLead[], month: { start: Date; endExclusive: Date },
): number {
  return leads.filter((lead) => lead.type === 'recruitment' && lead.outcome === 'won' && lead.outcomeAt !== null
    && lead.outcomeAt.getTime() >= month.start.getTime() && lead.outcomeAt.getTime() < month.endExclusive.getTime()).length;
}

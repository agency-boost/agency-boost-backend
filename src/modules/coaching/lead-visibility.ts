/**
 * **Who reads a coachee's lead text in what coaching recorded** (roles §3.7; the Phase 11 exit review's B1) —
 * the rule `showsLeadsTo` applies to a session and its print, and the Unit Dashboard's follow-up applies to
 * each row (Phase 15, the exit review's B1). Pure, so both read one copy, and a module that only needs the
 * rule does not import the session service and everything behind it.
 *
 * A session's own people read its lead names and lead-note text: its coach, any leader who coaches the
 * coachee now, and the coachee. Anybody else — the Owner or the Admin admitted office-wide, who is not above
 * the coachee — reads them only where their own `lead:read` reaches the coachee.
 */

/** Where a reader stands to a session, as far as its leads go. */
export interface LeadStanding {
  /** The reader led the session. */
  isCoach: boolean;
  /** The reader coaches the coachee now (`COACH`). */
  coachesNow: boolean;
  /** The reader is the coachee. */
  isCoachee: boolean;
}

/** The session's own people read its leads without asking anything more. */
export function knowsTheLeads(standing: LeadStanding): boolean {
  return standing.isCoach || standing.coachesNow || standing.isCoachee;
}

/** Anybody else reads them where their `lead:read` reaches the coachee: `null` is the whole office. */
export function leadsReached(leadReach: readonly string[] | null, coacheeMembershipId: string): boolean {
  return leadReach === null || leadReach.includes(coacheeMembershipId);
}

/** Last week's items as this reader reads them: every one, or — without the coachee's leads — the typed ones. */
export function shownLastWeekItems<T extends { leadId: string | null }>(items: readonly T[], leadsShown: boolean): T[] {
  return leadsShown ? [...items] : items.filter((item) => !item.leadId);
}

/**
 * The typed items as this reader reads them. An item *Start* carried forward from a lead-derived item of
 * last week keeps that lead's note as its text (`carriedFromItemId: 'lead-…'`), so a reader without the
 * coachee's leads reads every typed item but those (roles §3.7, the exit review's B1 residue).
 */
export function shownActionItems<T extends { carriedFromItemId: string | null }>(items: readonly T[], leadsShown: boolean): T[] {
  return leadsShown ? [...items] : items.filter((item) => !item.carriedFromItemId?.startsWith('lead-'));
}

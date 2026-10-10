/**
 * `OFFICE_HEADCOUNT` and `OFFICE_NEW_MEMBERS_THIS_MONTH` (Phase 18; OD-24 as refined 2026-10-09, OD-74).
 *
 * **One headcount, for every denominator** (OD-24): the office's memberships **active on the period's last
 * day** — every rung, the Owner and the Admins as the members they are. A pending membership never counts (it
 * has registered and nothing more), and a removed one counts only **before** it was removed (OD-74: a leaver
 * leaves every count of people from `validTo`, which for a membership is `removedAt`). The Overview's *Total
 * members*, the analytics' *Manpower* and every rate's denominator read this, so the 187 and the 195 the
 * prototype draws cannot both be shipped.
 *
 * Pure: rows in, a count out. The caller passes the **exclusive end of the period's last day in the office's
 * zone** (`Clock.endOfLocalDay`), so the day boundary is the office's (invariant §9).
 */

/** What a headcount reads of a membership. */
export interface CountedMembership {
  status: 'active' | 'pending' | 'removed';
  joinedAt: Date | null;
  removedAt: Date | null;
}

/**
 * **A member at the end of a day** (OD-24): joined before the day ended, and not removed by then. An active
 * membership with no `joinedAt` — a row older than the field — counts: it is here. A removed one with no
 * `removedAt` does not: nobody can say it was here then.
 */
export function memberAt(membership: CountedMembership, endOfDay: Date): boolean {
  if (membership.status === 'pending') return false;
  if (membership.joinedAt !== null && membership.joinedAt.getTime() >= endOfDay.getTime()) return false;
  if (membership.status === 'removed') {
    return membership.removedAt !== null && membership.removedAt.getTime() >= endOfDay.getTime();
  }
  return true;
}

/** `OFFICE_HEADCOUNT`: the memberships that are members at the end of the day. */
export function officeHeadcount(memberships: readonly CountedMembership[], endOfDay: Date): number {
  return memberships.filter((m) => memberAt(m, endOfDay)).length;
}

/**
 * `OFFICE_NEW_MEMBERS_THIS_MONTH` — *"+{n} new this month"* (`KPM_Owner.html:946`): the members counted at the
 * end of today whose membership began this calendar month in the office's zone (`[monthStart, endOfToday)`).
 * A person who left and rejoined is new on their new membership, as the directory lists them.
 */
export function officeNewMembers(
  memberships: readonly CountedMembership[], monthStart: Date, endOfToday: Date,
): number {
  return memberships.filter((m) => memberAt(m, endOfToday)
    && m.joinedAt !== null && m.joinedAt.getTime() >= monthStart.getTime()).length;
}

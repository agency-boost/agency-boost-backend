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
 * **A member counts from their join date** (ADR-0172 §1, ADR-0169 §5; P18.8-T5 AC-1): `memberships.joinDate`, the
 * office date their leader gave, is when they joined — `joinedAt` is only the system's stamp of when somebody let them
 * in, and the two can differ (a new hire approved a week after they started; a correction). The reader turns the join
 * date into the instant its office day begins (`joinDateStart`), and **`joinedAt` is the fallback** for a row with no
 * join date — one older than the field that migration 0040 has not reached. Removal is unchanged (ADR-0136).
 *
 * Pure: rows in, a count out. The caller passes the **exclusive end of the period's last day in the office's
 * zone** (`Clock.endOfLocalDay`), so the day boundary is the office's (invariant §9).
 */

/** What a headcount reads of a membership. */
export interface CountedMembership {
  status: 'active' | 'pending' | 'removed';
  /** The system's stamp: when the membership was made active. Read only where there is no join date. */
  joinedAt: Date | null;
  /**
   * **The instant the membership's join date begins in the office's zone** (`Clock.startOfLocalDay(timezone,
   * joinDate)`, ADR-0172 §1) — what every count of people reads. `null` or absent for a row with no join date, which
   * counts from `joinedAt`. Only a reader that resolves who was *in the system* at an instant leaves it out: an
   * event's audience (`event-audience.ts`).
   */
  joinDateStart?: Date | null;
  removedAt: Date | null;
}

/** **When a membership counts from**: its join date's first instant, or — with none — its `joinedAt`. */
export function countedFrom(membership: CountedMembership): Date | null {
  return membership.joinDateStart ?? membership.joinedAt;
}

/**
 * **A member at the end of a day** (OD-24): joined — by their join date (`countedFrom`) — on or before the day, and
 * not removed by then. An active membership with neither date — a row older than both fields — counts: it is here. A
 * removed one with no `removedAt` does not: nobody can say it was here then.
 */
export function memberAt(membership: CountedMembership, endOfDay: Date): boolean {
  if (membership.status === 'pending') return false;
  const from = countedFrom(membership);
  if (from !== null && from.getTime() >= endOfDay.getTime()) return false;
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
 * end of today whose **join date** is in this calendar month in the office's zone (`[monthStart, endOfToday)`;
 * `joinedAt` for a row with none, ADR-0172 §1). An existing agent added today with a join date years back is not new
 * this month: they were here all along. A person who left and rejoined is new on their new membership, as the
 * directory lists them.
 */
export function officeNewMembers(
  memberships: readonly CountedMembership[], monthStart: Date, endOfToday: Date,
): number {
  return memberships.filter((m) => {
    const from = countedFrom(m);
    return memberAt(m, endOfToday) && from !== null && from.getTime() >= monthStart.getTime();
  }).length;
}

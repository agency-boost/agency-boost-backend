import type { LocalDate } from '@/common/time/local-day';
import type { JoinedAs } from '@/domain/constants';

/**
 * **`COUNTS_FOR_PRODUCTION` — who a unit's production and *on pace* read** (ADR-0172 §2, P18.8-T5 AC-2;
 * `metrics-and-definitions.md`, *Counts for production*). **Defined here once**: the Unit Dashboard's totals and tiles,
 * its rows' *New hire* tag and every later reader of the same rule call `countsForProduction`.
 *
 * - **An existing agent always counts**, whatever their sales (§4) — and so does a membership not classified yet (no
 *   `joinedAs`: a pending row, or one older than the field), which is nobody's new hire.
 * - **A new hire counts from the day of their first sale** (`FIRST_SALE_DATE`, ADR-0171 §1): on that office day and
 *   every day after it. Before it — or with no first sale at all — they are left out of production totals and *On
 *   pace to be active*, numerator and denominator alike, and their roster row carries **New hire**.
 *
 * It does not touch who is *in the team* (manpower counts a new hire from their join date, §1) nor
 * `MONTHLY_ACTIVE_AGENT` (ADR-0054): a new hire with no sale has no production, so no month of theirs is active.
 *
 * Pure: two office dates compared as strings — `YYYY-MM-DD` sorts as the calendar does — so no instant and no zone is
 * involved; the caller passes the office's day (invariant §9).
 */

/** What the rule reads of a membership. */
export interface ProductionStanding {
  joinedAs: JoinedAs | null;
  /** `memberships.firstSaleDate`, an office date; `null` before a first sale. */
  firstSaleDate: LocalDate | null;
}

/** **`COUNTS_FOR_PRODUCTION`**: on `day`, does this member count in production totals and *on pace*? */
export function countsForProduction(member: ProductionStanding, day: LocalDate): boolean {
  if (member.joinedAs !== 'new_hire') return true;
  return member.firstSaleDate !== null && member.firstSaleDate <= day;
}

/**
 * **A new hire before their first sale** on `day` — the roster's ***New hire*** tag, and the rows a total leaves out.
 * The rule's other side, never a second rule: `!countsForProduction`.
 */
export function newHireBeforeFirstSale(member: ProductionStanding, day: LocalDate): boolean {
  return !countsForProduction(member, day);
}

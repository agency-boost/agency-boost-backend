import type { LocalDate } from '@/common/time/local-day';

/**
 * What is asking to be picked up (P7-T4). Derived on read, never stored.
 *
 * A constant and not only a type, so `ListLeadsQueryDto` can refuse an `attention` value outside it
 * without naming the three flags a second time.
 */
export const LEAD_FLAGS = ['overdue', 'no-next-action', 'no-remarks'] as const;
export type LeadFlag = (typeof LEAD_FLAGS)[number];

/**
 * **The one definition of a lead's attention flags** — the Leads screen's rows, its counts' check, and
 * the Personal Summary's *Leads that need you* (P10-T6) all read it, so no two screens can disagree
 * about what is overdue (invariant §8).
 *
 * `thisMonth` does **not** suppress them, which is where the prototype and this part company: it shows
 * only the green *Closes this month* chip on a lead that is also two weeks overdue, hiding exactly the
 * leads most needing attention (P7-T4 AC-2). A closed lead carries none.
 */
export function leadFlags(
  lead: { outcome: string | null; nextActionDate: string | null; remarks: string | null },
  today: LocalDate,
): LeadFlag[] {
  if (lead.outcome) return [];
  const flags: LeadFlag[] = [];
  /*
   * **Two flags, not one** (AC-4). Forgetting to set a date and missing one are different failures with
   * different answers: the first wants a decision, the second wants a call. The `else` is precedence
   * rather than suppression — a lead with no date cannot also be late for one — and it is the
   * prototype's own order (`leads-management.md` §4).
   */
  if (!lead.nextActionDate) flags.push('no-next-action');
  // `YYYY-MM-DD` sorts lexicographically in calendar order, which is the reason the field is stored in
  // this shape. `today` is the **office's** day (invariant §9, AC-3).
  else if (lead.nextActionDate < today) flags.push('overdue');
  if (!lead.remarks) flags.push('no-remarks');
  return flags;
}

import type { LocalDate } from '@/common/time/local-day';

/**
 * **The roster's *Flagged follow-up (system-detected)*** (OD-140, option 1, ADR-0124; `Overall.html:7287-7300`):
 * the person's **next open action item** — typed, or from a lead — from their latest session finalized at
 * least once, the one `DAYS_SINCE_LAST_COACHING` reads, by `CoachingReadings`' own rule.
 *
 * - **Its action items with text, and the lead actions it froze** (*From leads*, each a lead's next action
 *   as it stood at finalize). Both are what the session agreed; a blank typed item is not a follow-up.
 * - **Earliest due date first, undated after**; a tie keeps the typed items before the lead actions, and
 *   each list in the order the session holds it. The text is the item's, as stored.
 * - **Overdue by whole office days** when its date is before today — *Overdue {n}d* — else `null`, and the
 *   date is shown instead.
 *
 * Nothing in the session's record says an item is done: the next session ticks it, and the latest session
 * has no next one yet. So every item of the latest session is open.
 */
export interface FollowUp {
  text: string;
  dueDate: LocalDate | null;
  /** Whole days in the office's calendar past `dueDate`, when it is before today; otherwise `null`. */
  overdueDays: number | null;
}

export function nextFollowUp(
  /** The session's typed items, then its lead actions: the order a tie keeps. */
  items: readonly { text: string; dueDate: string | null }[],
  today: LocalDate,
  /** Whole days from one office date to another, in the office's zone (`Clock.daysBetween`). */
  between: (from: LocalDate, to: LocalDate) => number,
): FollowUp | null {
  const open = items
    .map((item, order) => ({ text: item.text, dueDate: item.dueDate, order }))
    .filter((item) => item.text.trim() !== '');
  if (open.length === 0) return null;
  const [first] = open.sort((a, b) => {
    if (a.dueDate !== b.dueDate) {
      if (a.dueDate === null) return 1;
      if (b.dueDate === null) return -1;
      return a.dueDate < b.dueDate ? -1 : 1;
    }
    return a.order - b.order;
  });
  return {
    text: first.text,
    dueDate: first.dueDate,
    overdueDays: first.dueDate !== null && first.dueDate < today ? between(first.dueDate, today) : null,
  };
}

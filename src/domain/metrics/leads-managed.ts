import type { LocalDate } from '@/common/time/local-day';

/**
 * **`MANAGED_LEADS_RATE` — *Leads Mgmt*, one member** (P19.19-T3 AC-2; ADR-0272 §6; OD-395;
 * `metrics-and-definitions.md` §A.21). The brief adds *Leads Mgmt* to the KPM Overview's compliance and defines it
 * nowhere; the default built: **a member manages their leads when they hold at least one open lead and every open lead
 * carries a next action that is not overdue** — a date set, today or later in the office's calendar.
 *
 * That is exactly a lead with neither of the two flags `leadFlags` raises (`no-next-action`, `overdue`;
 * `modules/leads/lead-attention.ts`), so the card and *Leads that need you* cannot disagree about a lead
 * (`leads-managed.spec.ts` holds them together). A member with no open lead has nothing in their pipeline to manage and
 * is **not** done: the card asks the owner to look at them.
 *
 * Pure: the member's open leads' next-action days (`LeadReadings.openNextActionsOfMany`) and the office's today in.
 */
export function leadsManaged(nextActionDates: readonly (string | null)[], today: LocalDate): boolean {
  return nextActionDates.length > 0 && nextActionDates.every((day) => day !== null && day !== '' && day >= today);
}

import type { Reader } from '@/common/i18n/reader';
import { render, type Sentence } from '@/common/i18n/sentence';
import { addDays, type LocalDate } from '@/common/time/local-day';
import { COACHING } from '@/domain/constants';
import { byNextAction } from '@/modules/leads/lead-readings';
import { COACHING_MESSAGES, COACHING_REFUSALS } from './coaching.messages';
import type {
  CoachingActionItem, CoachingLastWeekItem, CoachingLeadAction, CoachingSessionCorrection, CoachingTip,
} from './coaching-session.schema';

/**
 * **The session's rules, as pure functions** (P11-T5; `functional/coaching.md`, *The session*): what
 * *Start* copies and carries, what *From leads (automatic)* lists, the prototype's five finalize checks,
 * the reopen window, and which finalized version of a session counts. Records in, records out, so each
 * rule is a unit test (`coaching-session.rules.spec.ts`) and the service only reads and writes.
 */

/** A lead, as far as the session's rules read one. */
export interface SessionLead {
  id: string;
  name: string;
  nextActionDate: string | null;
  nextActionNote: string | null;
  /** Promised for the office's current month — the glossary's *Commitment*. */
  thisMonth: boolean;
  /** When it was registered, for the order leads were added in; 0 when unknown. */
  registeredAt: number;
}

/** What one finalized version agreed: the four lists a correction keeps whole (ADR-0042). */
export interface FinalizedVersion {
  version: number;
  lastWeekItems: CoachingLastWeekItem[];
  actionItems: CoachingActionItem[];
  tips: CoachingTip[];
  leadActions: CoachingLeadAction[];
  finalizedAt: Date;
  finalizedByMembershipId: string;
}

/** A session as the version rule reads it. */
export interface VersionedSession extends FinalizedVersion {
  status: 'draft' | 'finalized' | 'reopened';
  corrections: CoachingSessionCorrection[];
}

/**
 * **The finalized version that counts** (ADR-0079): a finalized session's own state; for one under
 * correction, the newest entry of `corrections[]`, which is the state its reopen kept whole; for a
 * draft never finalized, none.
 */
export function latestFinalized(session: {
  status: VersionedSession['status'];
  version: number;
  lastWeekItems: CoachingLastWeekItem[];
  actionItems: CoachingActionItem[];
  tips: CoachingTip[];
  leadActions: CoachingLeadAction[];
  finalizedAt: Date | null;
  finalizedByMembershipId: string | null;
  corrections: CoachingSessionCorrection[];
}): FinalizedVersion | null {
  if (session.status === 'finalized') {
    return {
      version: session.version,
      lastWeekItems: session.lastWeekItems,
      actionItems: session.actionItems,
      tips: session.tips,
      leadActions: session.leadActions,
      finalizedAt: session.finalizedAt as Date,
      finalizedByMembershipId: session.finalizedByMembershipId as string,
    };
  }
  // A reopen always pushes the state it replaced, so a reopened session has at least one.
  if (session.status === 'reopened') return session.corrections[session.corrections.length - 1];
  return null;
}

/**
 * ***Follow up with {name}*** when a lead's next action carries no note (`Overall.html:11057`): the
 * prototype's words for a dated lead with nothing written beside the date — **for `reader`** (P18.98-T5
 * AC-4, AC-6): the request's, live; the finalizing leader's, when the session stores them. A note is the
 * lead's own, as typed.
 */
export function leadActionText(lead: { name: string; nextActionNote: string | null }, reader: Reader): string {
  const note = lead.nextActionNote?.trim();
  return note ? note : render(COACHING_MESSAGES.followUpWith({ name: lead.name }), reader);
}

/**
 * ***From leads (automatic)*** (`Overall.html:11041-11059`): every lead of the coachee with a next action
 * date, **closed ones included**, nearest first — and in the order they were registered on a tie, then by
 * id, so two reads never shuffle (`byNextAction`, the leads module's own order).
 */
export function leadActionsOf(leads: readonly SessionLead[], reader: Reader): CoachingLeadAction[] {
  return leads
    .filter((lead) => lead.nextActionDate !== null)
    .sort(byNextAction)
    .map((lead) => ({
      leadId: lead.id, leadName: lead.name, dueDate: lead.nextActionDate as string, text: leadActionText(lead, reader),
    }));
}

/**
 * ***Last week's action items*** (ADR-0081): a copy of every action item the carried version agreed —
 * its typed ones, then its lead-derived ones with their *Leads · {name}* tag — each with its date and
 * **none ticked**: a tick is written by the session that reviews the item, never on the one it came from
 * (P11-T5 AC-2). A typed item keeps its id; a lead-derived one, which had none, is named by its lead.
 */
export function reviewedItems(version: Pick<FinalizedVersion, 'actionItems' | 'leadActions'>): CoachingLastWeekItem[] {
  return [
    ...version.actionItems.map((item) => ({
      itemId: item.itemId, text: item.text, dueDate: item.dueDate, leadId: null, leadName: null, done: false,
    })),
    ...version.leadActions.map((action) => ({
      itemId: `lead-${action.leadId}`, text: action.text, dueDate: action.dueDate,
      leadId: action.leadId, leadName: action.leadName, done: false,
    })),
  ];
}

/**
 * **Carry-forward at *Start*** (`Overall.html:10671-10679`, ADR-0081): every item of last week not done —
 * at *Start*, every one — into *Other action items* **with its date cleared**, **except an item whose
 * lead has a next action date now**, which *From leads (automatic)* lists live; and every tip, as
 * written. `newId` mints each copy's own id.
 */
export function carryForward(
  items: readonly CoachingLastWeekItem[],
  tips: readonly CoachingTip[],
  leads: readonly SessionLead[],
  newId: () => string,
): { actionItems: CoachingActionItem[]; tips: CoachingTip[] } {
  const dated = new Set(leads.filter((lead) => lead.nextActionDate !== null).map((lead) => lead.id));
  return {
    actionItems: items
      .filter((item) => !item.done && !(item.leadId !== null && dated.has(item.leadId)))
      .map((item) => ({ itemId: newId(), text: item.text, dueDate: null, carriedFromItemId: item.itemId })),
    tips: tips.map((tip) => ({ tipId: newId(), text: tip.text, carriedFromTipId: tip.tipId })),
  };
}

/** The prototype's five finalize checks, by the name `details.rule` gives each. */
export const FINALIZE_RULES = [
  'NO_ACTION_ITEM', 'EMPTY_TIP', 'EMPTY_ACTION_ITEM', 'UNDATED_ACTION_ITEM', 'LEAD_THIS_MONTH_UNDATED',
] as const;
export type FinalizeRule = (typeof FINALIZE_RULES)[number];

/** The first check that failed, and the lead the last one names. */
export interface FinalizeRefusal {
  rule: FinalizeRule;
  leadId?: string;
  leadName?: string;
}

/**
 * The prototype's sentence for each (`Overall.html:11111-11117`), which the refusal's message carries — in both
 * languages (P18.98-T5 AC-2).
 */
export function finalizeSentence(refusal: FinalizeRefusal): Sentence<'COACHING_SESSION_INCOMPLETE'> {
  const SAY = COACHING_REFUSALS.COACHING_SESSION_INCOMPLETE;
  switch (refusal.rule) {
    case 'NO_ACTION_ITEM':
      return SAY.noActionItem;
    case 'EMPTY_TIP':
      return SAY.emptyTip;
    case 'EMPTY_ACTION_ITEM':
      return SAY.emptyActionItem;
    case 'UNDATED_ACTION_ITEM':
      return SAY.undatedActionItem;
    case 'LEAD_THIS_MONTH_UNDATED':
      return SAY.leadThisMonthUndated({ leadName: refusal.leadName as string });
  }
}

const blank = (text: string) => text.trim() === '';

/**
 * **Finalize's five checks, in the prototype's order** (`Overall.html:11110-11117`), the first that fails
 * answering: no action item at all, lead-derived or typed; a blank tip; a blank typed item; an undated
 * typed item; a lead of the coachee promised for this month — closed ones included — with no next action
 * date, the first in the order its leads were registered. `null` when the session may be finalized.
 */
export function finalizeRefusal(input: {
  leadActions: readonly unknown[];
  actionItems: readonly { text: string; dueDate: string | null }[];
  tips: readonly { text: string }[];
  leads: readonly SessionLead[];
}): FinalizeRefusal | null {
  if (input.leadActions.length + input.actionItems.length === 0) return { rule: 'NO_ACTION_ITEM' };
  if (input.tips.some((tip) => blank(tip.text))) return { rule: 'EMPTY_TIP' };
  if (input.actionItems.some((item) => blank(item.text))) return { rule: 'EMPTY_ACTION_ITEM' };
  if (input.actionItems.some((item) => !item.dueDate)) return { rule: 'UNDATED_ACTION_ITEM' };
  const unplanned = [...input.leads]
    .sort((a, b) => a.registeredAt - b.registeredAt || (a.id < b.id ? -1 : 1))
    .find((lead) => lead.thisMonth && lead.nextActionDate === null);
  return unplanned ? { rule: 'LEAD_THIS_MONTH_UNDATED', leadId: unplanned.id, leadName: unplanned.name } : null;
}

/**
 * **The last day a session may be reopened** (ADR-0079): its `date` — the office's day of its first
 * finalize — plus `COACHING_REOPEN_WINDOW_DAYS`, inclusive. A correction never moves `date`, so finalizing
 * one does not restart the window.
 */
export function reopenableUntil(date: LocalDate): LocalDate {
  return addDays(date, COACHING.REOPEN_WINDOW_DAYS);
}

/** Is the office's `today` still inside the session's reopen window? */
export function reopenWindowOpen(date: LocalDate, today: LocalDate): boolean {
  return today <= reopenableUntil(date);
}

/**
 * **The key every goal save through a session coalesces under** (P11-T8; `functional/coaching.md`, *One
 * notice per session*): the session and its round — how many times it has been reopened. A correction is
 * a new round, so its saves are a new notice, emailed when the correction is finalized.
 */
export function coalesceKeyOf(session: { _id: unknown; corrections: readonly unknown[] }): string {
  return `${String(session._id)}:${session.corrections.length}`;
}

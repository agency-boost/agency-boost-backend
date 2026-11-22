import { render } from '@/common/i18n/sentence';
import { SOURCE_READER, type Reader } from '@/common/i18n/reader';
import type { LeaderMeetingActionItem, LeaderMeetingAgendaItem } from './leader-meeting.schema';
import { LEADER_MEETINGS_MESSAGES as SAY } from './leader-meetings.messages';

/**
 * **What a new forum starts with** (P19.22-T8 AC-3, AC-4; ADR-0276, amending ADR-0130 §3).
 *
 * - **The agenda** is the office's previous forum's — each line's text and PIC, **every box unticked**, each line a new
 *   one with an id of its own — or, in an office with none, the mockup's three lines, written in the language of the
 *   person making the forum and stored as text (ADR-0179 §7).
 * - **The action items** are the previous forum's that are not *Selesai*, copied: a new id, **the same lineage**, its
 *   text, PIC, *tenggat* and state, and *dari forum #n* — the number of the forum its lineage began in.
 */

/** A fresh agenda line: its own id, unticked, at version 1. */
function agendaLine(itemId: string, text: string, picMembershipId: string | null, picAll: boolean): LeaderMeetingAgendaItem {
  return { itemId, text, picMembershipId, picAll, done: false, version: 1 };
}

/**
 * **An office's first agenda** (the SLF mockup's checklist, `slf-tablet` frame 6): *Review angka MAPA driver dan informal
 * group* · *Update action items* (PIC *Semua*) · *Kesepakatan dan action items baru*, in `reader`'s language.
 */
export function firstAgenda(newId: () => string, reader: Reader = SOURCE_READER): LeaderMeetingAgendaItem[] {
  return [
    agendaLine(newId(), render(SAY.reviewNumbers, reader), null, false),
    agendaLine(newId(), render(SAY.updateActionItems, reader), null, true),
    agendaLine(newId(), render(SAY.agreeNewItems, reader), null, false),
  ];
}

/** **A new forum's agenda**: the previous forum's lines, unticked, each with a new id — or the first agenda. */
export function startingAgenda(
  previous: readonly LeaderMeetingAgendaItem[] | null, newId: () => string, reader: Reader = SOURCE_READER,
): LeaderMeetingAgendaItem[] {
  if (previous === null) return firstAgenda(newId, reader);
  return previous.map((from) => agendaLine(newId(), from.text, from.picMembershipId ?? null, from.picAll === true));
}

/**
 * **A copy of an action item carried into a later forum** (ADR-0276): a new id, the same lineage, the same text, PIC,
 * *tenggat* and state, and the number of the forum its lineage began in — `origin`, the forum it is copied from, when
 * the item was raised there.
 */
export function carriedCopy(
  from: Pick<LeaderMeetingActionItem, 'lineageId' | 'text' | 'picMembershipId' | 'dueOn' | 'status' | 'fromNumber'>,
  origin: number, itemId: string, order: number,
): LeaderMeetingActionItem {
  return {
    itemId,
    lineageId: from.lineageId,
    text: from.text,
    picMembershipId: from.picMembershipId ?? null,
    dueOn: from.dueOn ?? null,
    status: from.status,
    fromNumber: from.fromNumber ?? origin,
    order,
    version: 1,
  };
}

/** **The action items a new forum starts with**: the previous forum's not *Selesai*, copied in their order. */
export function carriedItems(
  previous: { number: number; actionItems: readonly LeaderMeetingActionItem[] } | null, newId: () => string,
): LeaderMeetingActionItem[] {
  if (!previous) return [];
  return [...previous.actionItems]
    .sort((a, b) => a.order - b.order)
    .filter((item) => item.status !== 'done')
    .map((item, order) => carriedCopy(item, previous.number, newId(), order));
}

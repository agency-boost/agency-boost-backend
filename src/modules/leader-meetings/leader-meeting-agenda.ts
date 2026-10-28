import type { AgendaSection, LeaderMeetingAgenda, LeaderMeetingAgendaItem } from './leader-meeting.schema';

/** The English month names *"Prepare {month} performance data"* is written with (D-copy). */
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const;

/** The month before a meeting's month, in English: *September* for a meeting on 13 October. */
export function monthBefore(meetingDate: string): string {
  const month = Number(meetingDate.slice(5, 7));
  return MONTH_NAMES[(month + 10) % 12];
}

/** A meeting's own month, in English: *October* for a meeting on 27 October (ADR-0176 §11). */
export function meetingMonth(meetingDate: string): string {
  return MONTH_NAMES[Number(meetingDate.slice(5, 7)) - 1];
}

/**
 * ***"Prepare {month} performance data"*** (`KPM_Owner.html:2501`), **naming the meeting's own month** — *October* for
 * a meeting on 27 October (ADR-0176 §11, amending ADR-0130 §3; P18.97-T2 AC-4, the client's UI-015, who read the month
 * before as a date left behind).
 */
export const preparePerformanceData = (meetingDate: string) => `Prepare ${meetingMonth(meetingDate)} performance data`;

/** The month item as any meeting wrote it — the month an English one — and nothing a leader typed around it. */
const MONTH_ITEM = new RegExp(`^Prepare (${MONTH_NAMES.join('|')}) performance data$`);

/**
 * **An agenda item's text for a new meeting** (ADR-0176 §11; P18.97-T2 AC-4): the month item re-dated to the new
 * meeting's month; every other item, and a month item a leader reworded, as typed.
 */
export function redated(text: string, meetingDate: string): string {
  return MONTH_ITEM.test(text) ? preparePerformanceData(meetingDate) : text;
}

/**
 * **An office's first agenda** (ADR-0130 §3): the prototype's ten items (`KPM_Owner.html:2500-2513`) verbatim —
 * three for *Preparation*, five for *During*, two for *Post* — **their PICs empty** (the prototype's *Wilson* is
 * its mock Owner), and *"Prepare {month} performance data"* naming the meeting's own month (ADR-0176 §11, where it
 * named the month before). *RBDO/BDO* verbatim and unexpanded (D-copy, OD-26).
 */
export function firstAgendaTexts(meetingDate: string): Record<AgendaSection, string[]> {
  return {
    preparation: [
      'Compile follow-ups & commitments from prior session',
      preparePerformanceData(meetingDate),
      'Review scorecard, draft talking points',
    ],
    during: [
      'Process update — review prior follow-ups',
      'Performance review vs. key thresholds',
      'Strategic priorities (Corporate)',
      'Strategic priorities (Agency)',
      'Summarize next steps & assign owners',
    ],
    post: [
      'Document outcomes into template',
      'Note feedback for RBDO/BDO',
    ],
  };
}

/** A fresh item: its own id, unticked, at version 1. */
function item(itemId: string, text: string, pic: string): LeaderMeetingAgendaItem {
  return { itemId, text, pic, done: false, version: 1 };
}

/**
 * **What a new meeting's agenda starts from** (D-forum-model, ADR-0130 §3): the office's latest meeting's — each
 * item's text and PIC, in its three sections, **every box unticked**, each item a new one with an id of its own, **its
 * month item re-dated to the new meeting's month** (ADR-0176 §11; P18.97-T2 AC-4) — or, in an office with none, the
 * first agenda above. Nothing of the tracker is carried: a new meeting has no rows.
 */
export function startingAgenda(
  meetingDate: string, previous: LeaderMeetingAgenda | null, newId: () => string,
): LeaderMeetingAgenda {
  if (previous) {
    const copy = (items: readonly LeaderMeetingAgendaItem[] | undefined) =>
      (items ?? []).map((from) => item(newId(), redated(from.text, meetingDate), from.pic));
    return { preparation: copy(previous.preparation), during: copy(previous.during), post: copy(previous.post) };
  }
  const texts = firstAgendaTexts(meetingDate);
  return {
    preparation: texts.preparation.map((text) => item(newId(), text, '')),
    during: texts.during.map((text) => item(newId(), text, '')),
    post: texts.post.map((text) => item(newId(), text, '')),
  };
}

/** *+ Add item* (`:2863`): *"New agenda item"*, no PIC, unticked. */
export const NEW_AGENDA_ITEM_TEXT = 'New agenda item';

/** *+ Add action item* (`:2869`): the prototype's new row, *Not yet planned*. */
export const NEW_ACTION_ITEM = {
  initiative: 'New initiative',
  metric: 'Success metric',
  action: 'New action item',
  pic: 'TBD',
  status: 'not_planned',
  remarks: 'TBD',
} as const;

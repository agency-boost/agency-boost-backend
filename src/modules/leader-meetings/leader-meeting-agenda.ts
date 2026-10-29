import { readerIn, SOURCE_READER, type Reader } from '@/common/i18n/reader';
import { render } from '@/common/i18n/sentence';
import { LANGUAGES, type Language } from '@/domain/constants';
import type { AgendaSection, LeaderMeetingAgenda, LeaderMeetingAgendaItem } from './leader-meeting.schema';
import { LEADER_MEETINGS_MESSAGES as SAY, MONTH_NAMES } from './leader-meetings.messages';

/**
 * **The words a new meeting is given are its maker's** (P18.98-T5 AC-6; ADR-0179 §7): the first agenda, and the rows
 * *+ Add item* and *+ Add action item* make, are written in the language of the person who makes them — `reader`,
 * the request's — and stored as text. From then they are the office's: copied as stored, edited as typed, and read
 * as stored in both languages (ADR-0179 §5). With no reader they are English, as before the phase.
 */

/** The month before a meeting's month, in English: *September* for a meeting on 13 October. */
export function monthBefore(meetingDate: string): string {
  const month = Number(meetingDate.slice(5, 7));
  return MONTH_NAMES.en[(month + 10) % 12];
}

/** A meeting's own month in full, in English unless asked: *October* — *Oktober* — for 27 October (ADR-0176 §11). */
export function meetingMonth(meetingDate: string, language: Language = 'en'): string {
  return MONTH_NAMES[language][Number(meetingDate.slice(5, 7)) - 1];
}

/**
 * ***"Prepare {month} performance data"*** (`KPM_Owner.html:2501`), **naming the meeting's own month** — *October* for
 * a meeting on 27 October (ADR-0176 §11, amending ADR-0130 §3; P18.97-T2 AC-4, the client's UI-015, who read the month
 * before as a date left behind) — in `reader`'s language: *Siapkan data kinerja Oktober*.
 */
export const preparePerformanceData = (meetingDate: string, reader: Reader = SOURCE_READER): string =>
  render(SAY.preparePerformanceData({ month: Number(meetingDate.slice(5, 7)) }), reader);

/**
 * The language a month item is written in — any meeting's, in either language, with nothing a leader typed around
 * it — or `null` for every other text.
 */
function monthItemLanguage(text: string): Language | null {
  return LANGUAGES.find((language) => MONTH_NAMES[language].some((_, i) =>
    render(SAY.preparePerformanceData({ month: i + 1 }), readerIn(language)) === text)) ?? null;
}

/**
 * **An agenda item's text for a new meeting** (ADR-0176 §11; P18.97-T2 AC-4): the month item re-dated to the new
 * meeting's month, **in the language it was written in** — the agenda is copied as stored; every other item, and a
 * month item a leader reworded, as typed.
 */
export function redated(text: string, meetingDate: string): string {
  const language = monthItemLanguage(text);
  return language === null ? text : preparePerformanceData(meetingDate, readerIn(language));
}

/**
 * **An office's first agenda** (ADR-0130 §3): the prototype's ten items (`KPM_Owner.html:2500-2513`) verbatim —
 * three for *Preparation*, five for *During*, two for *Post* — **their PICs empty** (the prototype's *Wilson* is
 * its mock Owner), and *"Prepare {month} performance data"* naming the meeting's own month (ADR-0176 §11, where it
 * named the month before). *RBDO/BDO* verbatim and unexpanded (D-copy, OD-26). **In `reader`'s language** (AC-6).
 */
export function firstAgendaTexts(meetingDate: string, reader: Reader = SOURCE_READER): Record<AgendaSection, string[]> {
  return {
    preparation: [
      render(SAY.compileFollowUps, reader),
      preparePerformanceData(meetingDate, reader),
      render(SAY.reviewScorecard, reader),
    ],
    during: [
      render(SAY.processUpdate, reader),
      render(SAY.performanceReview, reader),
      render(SAY.prioritiesCorporate, reader),
      render(SAY.prioritiesAgency, reader),
      render(SAY.summarizeNextSteps, reader),
    ],
    post: [
      render(SAY.documentOutcomes, reader),
      render(SAY.noteFeedback, reader),
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
 * first agenda above, **in the language of the person making the meeting** (P18.98-T5 AC-6). Nothing of the tracker
 * is carried: a new meeting has no rows.
 */
export function startingAgenda(
  meetingDate: string, previous: LeaderMeetingAgenda | null, newId: () => string, reader: Reader = SOURCE_READER,
): LeaderMeetingAgenda {
  if (previous) {
    const copy = (items: readonly LeaderMeetingAgendaItem[] | undefined) =>
      (items ?? []).map((from) => item(newId(), redated(from.text, meetingDate), from.pic));
    return { preparation: copy(previous.preparation), during: copy(previous.during), post: copy(previous.post) };
  }
  const texts = firstAgendaTexts(meetingDate, reader);
  return {
    preparation: texts.preparation.map((text) => item(newId(), text, '')),
    during: texts.during.map((text) => item(newId(), text, '')),
    post: texts.post.map((text) => item(newId(), text, '')),
  };
}

/** *+ Add item* (`:2863`): *"New agenda item"* — *Item agenda baru* — no PIC, unticked; in the adder's language. */
export function newAgendaItemText(reader: Reader = SOURCE_READER): string {
  return render(SAY.newAgendaItem, reader);
}

/** *+ Add action item* (`:2869`): the prototype's new row, *Not yet planned*; its words in the adder's language. */
export function newActionItem(reader: Reader = SOURCE_READER) {
  return {
    initiative: render(SAY.newInitiative, reader),
    metric: render(SAY.successMetric, reader),
    action: render(SAY.newActionItem, reader),
    pic: render(SAY.tbd, reader),
    status: 'not_planned' as const,
    remarks: render(SAY.tbd, reader),
  };
}

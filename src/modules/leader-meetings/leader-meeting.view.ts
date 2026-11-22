import { daysFrom } from '@/domain/metrics/usage';
import { LEADER_MEETING_LIMITS } from '@/domain/constants';
import type {
  ActionStatus, LeaderMeetingActionItem, LeaderMeetingAgendaItem, LeaderMeetingDocument,
} from './leader-meeting.schema';

/*
 * **The forum's answers, as the screen reads them** — `frontend/src/lib/leader-meetings.ts`, field for field (the
 * contract; P19.22-T8, ADR-0276). Nothing here is computed that the screen would otherwise decide: the state, how many
 * days to go, who may edit, what the reader may do and the bound of every field are the server's.
 */

/** *Akan datang* through the end of the forum's date in the office's calendar, *Selesai* from 00:00 after. */
export type MeetingState = 'upcoming' | 'completed';

export interface ForumPerson {
  membershipId: string;
  name: string;
  /** The first word of their name, as a PIC is drawn (*Agus*). */
  firstName: string;
  /** Their profile photo as a signed link (UI-111); `null` for none: the avatar draws initials. */
  photoUrl: string | null;
  rung: { code: string; label: string };
  /** The reader themselves. */
  isReader: boolean;
  /** Tagged *Core leader* now (ADR-0159 §1, ADR-0268): who the header's avatars and *"n core leader"* are. */
  tagged: boolean;
  /** One of the forum's editors now — the Owner, an Admin or a core leader: offered as a PIC (OD-418). */
  pickable: boolean;
}

export interface ForumLimits {
  textMax: number;
}

export interface MeetingCard {
  id: string;
  number: number;
  date: string;
  /** `HH:MM`, or `null` on a forum made before P19.22: drawn with its date alone. */
  time: string | null;
  state: MeetingState;
  /** Office days from today to its date: 0 today (*Hari ini*), 1 tomorrow (*Besok*), negative once past. */
  daysUntil: number;
  /** *Agenda n item*: its checklist's lines. */
  agendaCount: number;
  /** *Action items x/y selesai*. */
  actionProgress: { done: number; total: number };
}

export interface MeetingListView {
  /** The office's today, `YYYY-MM-DD`. */
  today: string;
  /** Newest first: by date, then time, then number. */
  meetings: MeetingCard[];
  /** *Forum berikutnya*: the nearest forum not yet held — by date, then time — or `null`. */
  nextId: string | null;
  /** The office's core leaders now, for the navy card's avatars and *"n core leader"*. */
  coreLeaders: ForumPerson[];
  can: { create: boolean };
  limits: ForumLimits;
}

export interface AgendaItem {
  id: string;
  text: string;
  /** A member (`ForumPerson` in `people`), or `null` — *Semua* when `picAll`, none otherwise. */
  picMembershipId: string | null;
  picAll: boolean;
  done: boolean;
  version: number;
}

export interface ActionItem {
  id: string;
  lineageId: string;
  text: string;
  picMembershipId: string | null;
  /** *Tenggat*, `YYYY-MM-DD`, or `null`. */
  dueOn: string | null;
  status: ActionStatus;
  /** *dari forum #n*: carried from the forum its lineage began in; `null` when raised in this one. */
  fromNumber: number | null;
  version: number;
}

export interface MeetingCan {
  /** Write the agenda and the action items. */
  edit: boolean;
  /** *Bagikan*: make a read-only link for WhatsApp. */
  share: boolean;
  /** Move its date or time — while it is upcoming. */
  reschedule: boolean;
  /** Delete it — while nobody has written in it. */
  delete: boolean;
  /** *PDF*: whoever reads it may print it. */
  print: boolean;
}

export interface MeetingView extends MeetingCard {
  version: number;
  /** The office's core leaders now (*"n core leader · semua bisa mengedit"*). */
  coreLeaders: ForumPerson[];
  /** Every person the screen draws: the editors, offered as PICs, and any PIC named who is no longer one. */
  people: ForumPerson[];
  agenda: AgendaItem[];
  actionItems: ActionItem[];
  writtenIn: boolean;
  via: 'address' | 'link';
  can: MeetingCan;
  limits: ForumLimits;
}

export interface ShareLink {
  /** The raw token: in this answer and nowhere else. */
  token: string;
  expiresAt: string;
}

/** The bound of every typed field, served so the screen keeps no copy of it (invariant §7). */
export const FORUM_LIMITS: ForumLimits = { ...LEADER_MEETING_LIMITS };

/**
 * **Akan datang or Selesai** (F-185): a forum is upcoming through the whole of its date in the office's calendar
 * — `today` is the office's — and completed from 00:00 the day after. `YYYY-MM-DD` compares in calendar order.
 */
export function meetingState(date: string, today: string): MeetingState {
  return date >= today ? 'upcoming' : 'completed';
}

/** *Agus* for *Agus Santoso*: the first word of a name. */
export const firstNameOf = (name: string): string => name.trim().split(/\s+/)[0] ?? '';

export function agendaItemOf(item: LeaderMeetingAgendaItem): AgendaItem {
  return {
    id: item.itemId, text: item.text, picMembershipId: item.picMembershipId ?? null, picAll: item.picAll === true,
    done: item.done === true, version: item.version,
  };
}

export function actionItemOf(row: LeaderMeetingActionItem): ActionItem {
  return {
    id: row.itemId, lineageId: row.lineageId, text: row.text, picMembershipId: row.picMembershipId ?? null,
    dueOn: row.dueOn ?? null, status: row.status, fromNumber: row.fromNumber ?? null, version: row.version,
  };
}

/** The action items in their order: by `order`, then as stored, so two given one place never swap. */
export function actionItemsInOrder(rows: readonly LeaderMeetingActionItem[]): ActionItem[] {
  return rows
    .map((row, at) => ({ row, at }))
    .sort((a, b) => a.row.order - b.row.order || a.at - b.at)
    .map(({ row }) => actionItemOf(row));
}

/** A forum's card, as the list draws it. */
export function cardOf(meeting: Pick<LeaderMeetingDocument, '_id' | 'number' | 'date' | 'time' | 'agendaItems' | 'actionItems'>, today: string): MeetingCard {
  const items = meeting.actionItems ?? [];
  return {
    id: String(meeting._id),
    number: meeting.number,
    date: meeting.date,
    time: meeting.time ?? null,
    state: meetingState(meeting.date, today),
    daysUntil: daysFrom(today, meeting.date),
    agendaCount: (meeting.agendaItems ?? []).length,
    actionProgress: { done: items.filter((row) => row.status === 'done').length, total: items.length },
  };
}

/** `date` then `time` as one sortable key; a forum with no time sorts first on its day. */
const when = (card: Pick<MeetingCard, 'date' | 'time'>) => `${card.date} ${card.time ?? '00:00'}`;

/** Newest first: by date, then time, then number. */
export function newestFirst<T extends Pick<MeetingCard, 'date' | 'time' | 'number'>>(cards: readonly T[]): T[] {
  return [...cards].sort((a, b) => (when(a) < when(b) ? 1 : when(a) > when(b) ? -1 : b.number - a.number));
}

/** **Forum berikutnya**: the nearest forum not yet held, by date then time then number; `null` with none. */
export function nextForumOf(cards: readonly MeetingCard[]): MeetingCard | null {
  const upcoming = cards.filter((c) => c.state === 'upcoming');
  return newestFirst(upcoming).at(-1) ?? null;
}

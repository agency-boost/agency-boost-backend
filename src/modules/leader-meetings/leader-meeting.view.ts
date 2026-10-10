import { LEADER_MEETING_LIMITS } from '@/domain/constants';
import type { ColumnKey, ComputedScorecard, ScorecardCell, ScorecardUnit, RowKey } from './scorecard/scorecard.types';
import { TARGET_ROW_KEYS } from './scorecard/scorecard.types';
import type {
  ActionStatus, AgendaSection, LeaderMeetingActionItem, LeaderMeetingAgenda, LeaderMeetingAgendaItem,
  MonthlyTargetCell,
} from './leader-meeting.schema';

/*
 * **The forum's answers, as the screen reads them** — `frontend/src/lib/leader-meetings.ts`, field for field
 * (the contract). Nothing here is computed that the screen would otherwise decide: the state, who may edit, what
 * the reader may do and the bounds of every field are the server's.
 */

/** *Upcoming* through the end of the meeting's date in the office's calendar, *Completed* from 00:00 after. */
export type MeetingState = 'upcoming' | 'completed';

export interface ForumPerson {
  membershipId: string;
  name: string;
  rung: { code: string; label: string };
  /** The reader themselves: *"(You)"* after the name. */
  isReader: boolean;
  /**
   * Tagged *Core Leader* — now, or at the freeze on a frozen list. What *"{n} core leaders tagged"* counts, the Owner
   * aside, so the card can draw exactly the editors it counts (an Admin may be tagged too).
   */
  tagged: boolean;
}

/** *Can edit this MOM*: each person once, the Owner first, then the Admins, then the other Core Leaders. */
export interface MeetingEditors {
  owner: ForumPerson | null;
  admins: ForumPerson[];
  coreLeaders: ForumPerson[];
  /** *"{n} core leaders tagged"*: every editor tagged Core Leader but the Owner. */
  coreLeaderCount: number;
  /** True once the meeting is *Completed* and the list is the one written onto it at the freeze. */
  frozen: boolean;
}

export interface ForumLimits {
  titleMax: number;
  textMax: number;
  picMax: number;
  targetMax: number;
}

export interface MeetingCard {
  id: string;
  number: number;
  title: string;
  date: string;
  state: MeetingState;
  editors: MeetingEditors;
  /** The tracker's rows not *Implemented*. 0 reads *All clear*. */
  openItems: number;
}

export interface MeetingListView {
  meetings: MeetingCard[];
  can: { create: boolean };
  limits: ForumLimits;
}

export interface ScorecardRow {
  key: RowKey;
  unit: ScorecardUnit;
  cells: Record<ColumnKey, ScorecardCell>;
  /** `null` where the prototype blocks the cell. A cell never typed is `{ value: '', version: 0 }`. */
  monthlyTarget: MonthlyTargetCell | null;
}

export interface Scorecard {
  periods: Record<ColumnKey, string>;
  chips: ComputedScorecard['chips'];
  rows: ScorecardRow[];
  /** `null` while live; the instant it was frozen onto the meeting otherwise. */
  frozenAt: string | null;
}

export interface AgendaItem {
  id: string;
  text: string;
  pic: string;
  done: boolean;
  version: number;
}

export interface ActionItem {
  id: string;
  initiative: string;
  metric: string;
  action: string;
  pic: string;
  status: ActionStatus;
  remarks: string;
  version: number;
}

export interface MeetingCan {
  edit: boolean;
  share: boolean;
  reschedule: boolean;
  delete: boolean;
  manageTags: boolean;
  print: boolean;
}

export interface MeetingView extends MeetingCard {
  version: number;
  branch: string;
  scorecard: Scorecard;
  agenda: Record<AgendaSection, AgendaItem[]>;
  actionItems: ActionItem[];
  writtenIn: boolean;
  via: 'address' | 'link';
  accessNote: { ownerName: string | null; adminNames: string[] };
  can: MeetingCan;
  limits: ForumLimits;
}

export interface ShareLink {
  /** The raw token: in this answer and nowhere else. */
  token: string;
  expiresAt: string;
}

/** The bounds of every typed field, served so the screen keeps no copy of them (invariant §7). */
export const FORUM_LIMITS: ForumLimits = { ...LEADER_MEETING_LIMITS };

/**
 * **Upcoming or Completed** (F-185): a meeting is upcoming through the whole of its date in the office's calendar
 * — `today` is the office's — and completed from 00:00 the day after. `YYYY-MM-DD` compares in calendar order.
 */
export function meetingState(date: string, today: string): MeetingState {
  return date >= today ? 'upcoming' : 'completed';
}

/** The rows not *Implemented* (`:2586`). */
export function openItemsOf(actionItems: readonly LeaderMeetingActionItem[]): number {
  return actionItems.filter((row) => row.status !== 'implemented').length;
}

export function agendaItemOf(item: LeaderMeetingAgendaItem): AgendaItem {
  return { id: item.itemId, text: item.text, pic: item.pic, done: item.done, version: item.version };
}

export function agendaOf(agenda: LeaderMeetingAgenda | null | undefined): Record<AgendaSection, AgendaItem[]> {
  return {
    preparation: (agenda?.preparation ?? []).map(agendaItemOf),
    during: (agenda?.during ?? []).map(agendaItemOf),
    post: (agenda?.post ?? []).map(agendaItemOf),
  };
}

export function actionItemOf(row: LeaderMeetingActionItem): ActionItem {
  return {
    id: row.itemId, initiative: row.initiative, metric: row.metric, action: row.action, pic: row.pic,
    status: row.status, remarks: row.remarks, version: row.version,
  };
}

/** The tracker's rows in their order: by `order`, then as stored, so two rows given one place never swap. */
export function actionItemsInOrder(rows: readonly LeaderMeetingActionItem[]): ActionItem[] {
  return rows
    .map((row, at) => ({ row, at }))
    .sort((a, b) => a.row.order - b.row.order || a.at - b.at)
    .map(({ row }) => actionItemOf(row));
}

/**
 * **The scorecard the meeting serves** (OD-144): the computed one — live, or as frozen — with each row's typed
 * *Monthly Target* laid over it. A blocked row takes none (`null`); a row never typed reads `{ value: '',
 * version: 0 }`. The targets are never frozen.
 */
export function scorecardOf(
  computed: ComputedScorecard,
  targets: Partial<Record<string, MonthlyTargetCell>> | null | undefined,
  frozenAt: Date | null,
): Scorecard {
  const typed = (TARGET_ROW_KEYS as readonly string[]);
  return {
    periods: computed.periods,
    chips: computed.chips,
    rows: computed.rows.map((row) => ({
      key: row.key,
      unit: row.unit,
      cells: row.cells,
      monthlyTarget: typed.includes(row.key)
        ? { value: targets?.[row.key]?.value ?? '', version: targets?.[row.key]?.version ?? 0 }
        : null,
    })),
    frozenAt: frozenAt ? frozenAt.toISOString() : null,
  };
}

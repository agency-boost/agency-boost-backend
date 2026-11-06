import { LEADER_MEETING_LIMITS, LEADER_MEETING_TARGET_RATE_DECIMALS } from '@/domain/constants';
import { rateOver } from '@/domain/metrics/rate';
import type { ScorecardAsOf, ScorecardRecord } from './scorecard/scorecard-record';
import type {
  ColumnKey, ColumnPeriod, ScorecardCell, ScorecardChips, ScorecardDefinitions, ScorecardUnit, RowKey, TargetRowKey,
} from './scorecard/scorecard.types';
import { COLUMN_KEYS, TARGET_ROW_KEYS } from './scorecard/scorecard.types';
import type {
  ActionStatus, AgendaSection, LeaderMeetingActionItem, LeaderMeetingAgenda, LeaderMeetingAgendaItem,
  MonthlyTargetCell, TextTargetCell,
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
  /** Their profile photo as a signed link (UI V1, UI-111); `null` for none: the avatar draws initials. */
  photoUrl: string | null;
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

/**
 * **A *Monthly Target*, as the table draws it** (ADR-0175 §4, P18.9-T1 AC-10): the rate typed per unit and **its
 * value, `rate × # of units`** — the meeting's own units, the frozen ones once frozen — or, with no rate, the text a
 * target was typed as before rates where migration `0043` could not read one (AC-11). A cell never typed is version 0.
 */
export interface MonthlyTarget {
  /** Per unit, in the row's unit: IDR minor units for `ape`, a count for the others; `null` for none. */
  rate: number | null;
  /** `rate × # of units`, in the same unit; `null` with no rate. */
  value: number | null;
  /** A target typed as text before rates, shown as typed while there is no rate; `null` otherwise. */
  typed: string | null;
  version: number;
}

/**
 * **What a change is counted in** (P18.9-T8 F1, parity F-256): `percent`, a whole percentage of last year's figure;
 * `points`, the difference between two percentages in whole percentage points.
 */
export type YtdChangeUnit = 'percent' | 'points';

/**
 * **A phone's card's change** (P18.9-T1 AC-17): *YTD {Y}* against *YTD {Y−1}*, computed here once (invariant §7) —
 * a whole percentage of last year's for a count, a sum or a ratio (`rateOver`), and **for a row whose own figure is a
 * percentage, the difference in whole percentage points** (P18.9-T8 F1): a share of a share reads as either, so 60%
 * against 100% is *−40 points*, never *−40%*. **`none`**, *—*, where either is no figure, or — a percentage of
 * last year's — last year's is 0.
 */
export type YtdChange = { kind: 'figure'; value: number; unit: YtdChangeUnit } | { kind: 'none' };

export interface ScorecardRow {
  key: RowKey;
  unit: ScorecardUnit;
  cells: Record<ColumnKey, ScorecardCell>;
  ytdChange: YtdChange;
  /** `null` on a row the table does not track in the *Monthly View*. A cell never typed has no rate, at version 0. */
  monthlyTarget: MonthlyTarget | null;
}

/**
 * **A period one or more of whose figures leaves months out** (P18.9-T1 AC-12): the column, and every month any of
 * its figures names — what its *(\*)* note says, each figure that leaves one out marked *\**.
 */
export interface PartialPeriod {
  column: ColumnKey;
  leavesOut: string[];
}

export interface Scorecard {
  /** Each column's months, `YYYY-MM` to `YYYY-MM`, from the meeting's month: its header's second line. */
  periods: Record<ColumnKey, ColumnPeriod>;
  chips: ScorecardChips;
  /** Nine, in the reference slide's order. */
  rows: ScorecardRow[];
  /** *AS OF*: the day of the office's latest upload; none while it has no file; unrecorded on a scorecard frozen before it. */
  asOf: ScorecardAsOf;
  /** The *(\*)* notes' periods, in column order; empty when every figure covers its whole period. */
  partialPeriods: PartialPeriod[];
  /** `null` while live; the instant it was frozen onto the meeting otherwise. */
  frozenAt: string | null;
  /**
   * **Which definitions the rows follow** (P19.3-T1; ADR-0202 §4): `data_sources` — live, or frozen since P19.3-T1 —
   * or `reference_slide`, frozen before it. The footnotes the screen draws are this one's, so a footnote never describes
   * a figure it is not.
   */
  definitions: ScorecardDefinitions;
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

/** A target's value is rounded to the places its rate is typed to (`LEADER_MEETING_TARGET_RATE_DECIMALS`): a hundredth. */
const TARGET_VALUE_SCALE = 10 ** LEADER_MEETING_TARGET_RATE_DECIMALS;

/**
 * **A stored target as the table draws it** (P18.9-T1 AC-10, AC-11): its rate times the meeting's units. A cell still
 * in the text it was typed in before rates — a database migration `0043` has not reached — shows that text as typed,
 * with no rate, as one the migration could not read does. Never parsed here: reading a text as a rate is the
 * migration's alone.
 */
export function monthlyTargetOf(stored: MonthlyTargetCell | TextTargetCell | null | undefined, units: number): MonthlyTarget {
  if (!stored) return { rate: null, value: null, typed: null, version: 0 };
  if ('rate' in stored) {
    const { rate } = stored;
    return {
      rate,
      // Rounded to the places a count's rate is typed to, so the product of two decimals carries no binary noise.
      value: rate === null ? null : Math.round(rate * units * TARGET_VALUE_SCALE) / TARGET_VALUE_SCALE,
      typed: rate === null ? stored.typed ?? null : null,
      version: stored.version,
    };
  }
  return { rate: null, value: null, typed: stored.value === '' ? null : stored.value, version: stored.version };
}

/**
 * The places a stored percentage could carry — a scorecard frozen before the whole percent (ADR-0174 §1) held a tenth
 * — counted in whole numbers, so that a tenth's binary noise (`33.3 − 20.8` is `12.499999999999996`) never moves a
 * half.
 */
const POINT_PARTS = 10_000;

/**
 * *YTD {Y}* against *YTD {Y−1}* — `none` where either is no figure.
 *
 * - **A row whose figure is a percentage** (`unit: 'percentage'`, *3M new agent %*; P18.9-T8 F1): the difference in
 *   whole percentage points, rounded half up toward +∞ as `rateOver` rounds — *60%* against *100%* is −40, *45%*
 *   against *30%* is +15. A difference from 0% is a difference, so last year's 0 is not `none` here.
 * - **Every other row**: a whole percentage of last year's — `none` where last year's is 0. Whole figures — counts,
 *   sums in sen — through `rateOver`, the one rounding of a whole percentage (ADR-0174 §1); an average, a fraction, by
 *   the same half-up rule on its exact quotient, which `rateOver`'s integer arithmetic is not for.
 */
export function ytdChangeOf(cells: Record<ColumnKey, ScorecardCell>, unit: ScorecardUnit): YtdChange {
  const [now, then] = [cells.ytd, cells.ytdLastYear];
  if (now.kind !== 'figure' || then.kind !== 'figure') return { kind: 'none' };
  if (unit === 'percentage') {
    const parts = Math.round(now.value * POINT_PARTS) - Math.round(then.value * POINT_PARTS);
    return { kind: 'figure', value: Math.floor((parts + POINT_PARTS / 2) / POINT_PARTS), unit: 'points' };
  }
  if (then.value === 0) return { kind: 'none' };
  const change = now.value - then.value;
  const pct = Number.isInteger(now.value) && Number.isInteger(then.value)
    ? rateOver(change, then.value).pct!
    : Math.floor((change * 100) / then.value + 0.5);
  return { kind: 'figure', value: pct, unit: 'percent' };
}

/** Every period one of whose figures leaves months out, with the months, in column order. */
export function partialPeriodsOf(rows: readonly { cells: Record<ColumnKey, ScorecardCell> }[]): PartialPeriod[] {
  return COLUMN_KEYS.flatMap((column) => {
    const months = [...new Set(rows.flatMap((r) => {
      const cell = r.cells[column];
      return cell.kind === 'figure' ? cell.leavesOut : [];
    }))].sort();
    return months.length === 0 ? [] : [{ column, leavesOut: months }];
  });
}

/**
 * **The scorecard the meeting serves** (OD-144, ADR-0175): the record — live, or as frozen, read tolerantly
 * (`scorecard-record.ts`) — with each row's typed *Monthly Target* laid over it at the record's own *# of units*, each
 * row's *YTD* change, and the periods its *(\*)* notes name. A row the table does not track in the *Monthly View* takes
 * no target (`null`). The targets are never frozen.
 */
export function scorecardOf(
  record: ScorecardRecord,
  targets: Partial<Record<string, MonthlyTargetCell | TextTargetCell>> | null | undefined,
  frozenAt: Date | null,
): Scorecard {
  const typed = (TARGET_ROW_KEYS as readonly string[]);
  return {
    periods: record.periods,
    chips: record.chips,
    rows: record.rows.map((row) => ({
      key: row.key,
      unit: row.unit,
      cells: row.cells,
      ytdChange: ytdChangeOf(row.cells, row.unit),
      monthlyTarget: typed.includes(row.key)
        ? monthlyTargetOf(targets?.[row.key as TargetRowKey], record.chips.units)
        : null,
    })),
    asOf: record.asOf,
    partialPeriods: partialPeriodsOf(record.rows),
    frozenAt: frozenAt ? frozenAt.toISOString() : null,
    definitions: record.definitions,
  };
}

import type { LocalDate } from '@/common/time/local-day';
import type { ActivationLinkView } from './activation.service';
import type { ActivationItemSource, ActivationRecordCollection } from './activation-progress.schema';
import type { ActivationState, AspectStatus } from './activation-rules';

/**
 * **The activation's wire shapes** (`functional/activation.md`, the Data contract). The response DTOs
 * `implements` each, so the document and the code cannot drift.
 */

/** A member, as an activation names them: the membership and the full name. */
export interface ActivationPersonView {
  membershipId: string;
  name: string;
}

/** One item of the pinned version, with its state. */
export interface ActivationItemProgressView {
  /** The pinned version's code (invariant §4). */
  code: string;
  label: string;
  /** The link, resolved; `null` for a manual item. `live` says nobody ticks it by hand. */
  link: ActivationLinkView | null;
  done: boolean;
  /** An instant. */
  doneAt: string | null;
  source: ActivationItemSource | null;
  /** Who ticked it — or, for a link, whoever wrote the completing record. */
  doneBy: ActivationPersonView | null;
  /** The hire's own note: **only** in the hire's own read, `null` in every leader's. */
  note: string | null;
  /** The hire's own date, an office date: **only** in the hire's own read. */
  date: LocalDate | null;
  /**
   * **Ticked by hand, waiting for data** (P18.96-T4 AC-4): a data-backed item done by the hire or a leader, which its
   * data has not confirmed yet. It reads as the link's — `source: 'link'`, this `false` — from the read its data
   * appears on.
   */
  waiting: boolean;
  /** The record a done data-backed item names — the lead, the 1:1, the file's month — for its source line. */
  record: ActivationItemRecordView | null;
}

/** A record an item names (P18.96-T4 AC-2): its collection and its id, which the screen turns into a link. */
export interface ActivationItemRecordView {
  collection: ActivationRecordCollection;
  id: string;
}

/** One of a member's closings (P18.96-T4 AC-3): what *Which case?* offers to name. */
export interface ActivationClosingView {
  leadId: string;
  /** The person the case was sold to: the lead's name. */
  name: string;
  /** The office day it first reached *Paid and issued*. */
  date: LocalDate;
}

/** `GET /activation/me/closings` and `GET /new-hires/:membershipId/closings`. */
export interface ActivationClosingsView {
  closings: ActivationClosingView[];
}

export interface ActivationAspectProgressView {
  code: string;
  label: string;
  status: AspectStatus;
  done: number;
  total: number;
  items: ActivationItemProgressView[];
}

/** The leader's coaching note, shown to the hire read-only (OD-117). */
export interface ActivationNoteView {
  text: string;
  by: ActivationPersonView;
  /** An instant. */
  at: string;
}

/** **One hire's activation**, as every reader is served it: the hire, a leader, a coach. */
export interface ActivationView {
  hire: ActivationPersonView;
  state: ActivationState;
  startDate: LocalDate;
  /** A leader's correction of the start date (OD-118), or `null` while it is the join date. */
  startCorrected: { by: ActivationPersonView; at: string } | null;
  /** The office's today: the page computes no day. */
  today: LocalDate;
  day: number;
  window: number;
  overdue: boolean;
  endsOn: LocalDate;
  done: number;
  total: number;
  pct: number;
  aspects: ActivationAspectProgressView[];
  firstCaseClosed: boolean;
  /** An instant. */
  graduatedAt: string | null;
  graduatedBy: ActivationPersonView | null;
  note: ActivationNoteView | null;
}

/**
 * *Direct Unit*, or the nearest leader below the reader — an AAB, or an AB under an AB, naming the rung (D-group): the
 * unit a new hire is counted in on `/new-hires`.
 */
export interface NewHireUnitRefView {
  kind: 'direct' | 'aab' | 'ab';
  /** `null` for `direct`. */
  leader: ActivationPersonView | null;
}

/** A new hire's checklist, where they have one (an Agent placed by a leader, ADR-0103): how far it is, and overdue. */
export interface NewHireChecklistView {
  state: ActivationState;
  done: number;
  total: number;
  pct: number;
  /** Open past the office's window below 100% (`isOverdue`). */
  overdue: boolean;
}

/** One new hire on `/new-hires` (ADR-0173 §2; P18.96-T6 AC-3). */
export interface NewHireRowView {
  hire: ActivationPersonView;
  unit: NewHireUnitRefView;
  /** *Join date*: day 1. */
  joinDate: LocalDate;
  /** Which day of their first 90 today is (`activation3MDay`): what *In progress* prints. */
  day: number;
  /** `FIRST_SALE_DATE`, or `null` with none. */
  firstSaleDate: LocalDate | null;
  /** `ACTIVATION_3M`. */
  activation3M: Activation3MResultView;
  /** The office day they were marked left; `null` while not. */
  leftOn: LocalDate | null;
  /** `null` for a new hire with no checklist: an AB or an AAB, or an office with none published. */
  checklist: NewHireChecklistView | null;
}

/** `ACTIVATION_3M`'s three values. */
export type Activation3MResultView = 'in_progress' | 'activated' | 'not_activated';

/** `ACTIVATION_3M_PCT` over a set: the counts and the share, `pct` `null` while nobody is decided. */
export interface Activation3MShareView {
  activated: number;
  notActivated: number;
  inProgress: number;
  pct: number | null;
}

/** The share of one join month's new hires: its cohort. */
export interface Activation3MMonthView extends Activation3MShareView {
  /** `YYYY-MM`. */
  month: string;
}

/** A set's `ACTIVATION_3M_PCT`: all of it, and each join month in it, newest first. */
export interface Activation3MFiguresView {
  all: Activation3MShareView;
  byMonth: Activation3MMonthView[];
}

/** One unit's figures: *Direct Unit*, or an AAB's or an AB's below the reader. */
export interface NewHireUnitView extends NewHireUnitRefView {
  activation3M: Activation3MFiguresView;
}

/** `GET /new-hires` (ADR-0173; P18.96-T6 AC-2, AC-3). */
export interface NewHiresRosterView {
  today: LocalDate;
  /** The join dates listed: the page's year (`newHiresWindow`). */
  window: { from: LocalDate; to: LocalDate };
  /** `ACTIVATION_3M.DAYS`: the day the result locks on, what *Day 64 of 90* prints. */
  days: number;
  /** The reader's scope: every new hire listed. */
  activation3M: Activation3MFiguresView;
  /** Each unit with a new hire listed — *Direct Unit* first, then the leaders A to Z. */
  units: NewHireUnitView[];
  sections: {
    /** By day, highest first; ties by name. */
    inProgress: NewHireRowView[];
    /** By join date, newest first; ties by name. */
    activated: NewHireRowView[];
    /** By join date, newest first; ties by name. *Left* ones among them. */
    notActivated: NewHireRowView[];
  };
}

/** What *Mark left* answers (P18.96-T6 AC-4). */
export interface NewHireMarkedLeftView {
  membershipId: string;
  leftAt: string;
  leftOn: LocalDate;
  activation3M: 'activated' | 'not_activated';
}

/** What saving the coaching note answers. */
export interface ActivationNoteSavedView {
  note: ActivationNoteView;
}

import type { LocalDate } from '@/common/time/local-day';
import type { ActivationLinkView } from './activation.service';
import type { ActivationItemSource } from './activation-progress.schema';
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

/** One row of *Your New Hires*. */
export interface NewHireRowView {
  hire: ActivationPersonView;
  /** What the *Joined* column prints (`:6734-6736`). */
  startDate: LocalDate;
  day: number;
  window: number;
  overdue: boolean;
  pct: number;
  /** *Active Agent*: the item `FIRST_CASE_CLOSED` is done. */
  firstCaseClosed: boolean;
}

/**
 * A card of the roster: *Direct Unit*, or the nearest leader below the reader — an AAB, or an AB under
 * an AB, the card naming the rung (D-group).
 */
export interface NewHireGroupView {
  kind: 'direct' | 'aab' | 'ab';
  /** `null` for `direct`. */
  leader: ActivationPersonView | null;
  /** By day, highest first. */
  hires: NewHireRowView[];
}

export interface NewHiresRosterView {
  /** Empty groups are omitted. */
  groups: NewHireGroupView[];
  today: LocalDate;
}

/** What saving the coaching note answers. */
export interface ActivationNoteSavedView {
  note: ActivationNoteView;
}

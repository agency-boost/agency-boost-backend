import type { LocalDate } from '@/common/time/local-day';
import type { NewHireYear } from '@/domain/metrics/activation-3m';
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
   * **Ticked by hand, waiting for data** (P18.8-T4 AC-4): a data-backed item done by the hire or a leader, which its
   * data has not confirmed yet. It reads as the link's — `source: 'link'`, this `false` — from the read its data
   * appears on.
   */
  waiting: boolean;
  /** The record a done data-backed item names — the lead, the 1:1, the file's month — for its source line. */
  record: ActivationItemRecordView | null;
}

/** A record an item names (P18.8-T4 AC-2): its collection and its id, which the screen turns into a link. */
export interface ActivationItemRecordView {
  collection: ActivationRecordCollection;
  id: string;
}

/** One of a member's closings (P18.8-T4 AC-3): what *Which case?* offers to name. */
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

/**
 * Where a first sale came from, as `/new-hires` says it (UI V1, UI-023, D-26): `sales` — a sales lead at *Paid and
 * issued* or the production file — or `manual`, a closing a leader or the hire logged from the checklist.
 */
export type FirstSaleSourceView = 'sales' | 'manual';

/**
 * A new hire as their row names them (P19.11-T2 AC-4, UX-14): the person, and their profile photo as a signed link —
 * `null` without one, which the row draws as initials — for the circle of a hire not activated yet.
 */
export interface NewHirePersonView extends ActivationPersonView {
  photoUrl: string | null;
}

/** One new hire on `/new-hires` (ADR-0173 §2; P18.8-T6 AC-3; UI V1, UI-023). */
export interface NewHireRowView {
  hire: NewHirePersonView;
  unit: NewHireUnitRefView;
  /** *Join date*: day 1. */
  joinDate: LocalDate;
  /** Which day since joining today is (`activation3MDay`): *"Hari ke-X"*. */
  day: number;
  /** `FIRST_SALE_DATE`, or `null` with none. */
  firstSaleDate: LocalDate | null;
  /** The first sale's day since joining, the join date day 1: *"Pecah telor di hari ke-X"*. `null` with none. */
  firstSaleDay: number | null;
  /** Where `firstSaleDate` came from; `null` with none. */
  firstSaleSource: FirstSaleSourceView | null;
  /**
   * **The row's status** (UI V1, D-24): `activated` — a first sale by day 90; `activated_late` — a first sale after it,
   * amber, in the 3M share's denominator and not its numerator (P19.11-T2 AC-2); `not_yet` — none.
   */
  status: NewHireStatusView;
  /** `ACTIVATION_3M`: the 3M result itself — `activated` by day 90, `not_activated` past it, else `in_progress`. */
  activation3M: Activation3MResultView;
  /**
   * The office day they were marked left; `null` while not. **Stored, not a status** (UI V1, D-24, UI-025): nothing on
   * the page reads it, and it decides nothing — their row opens as anybody's (P19.11-T2 AC-1), their detail read-only.
   */
  leftOn: LocalDate | null;
  /** `null` for a new hire with no checklist: an AB or an AAB, or an office with none published. */
  checklist: NewHireChecklistView | null;
}

/** `ACTIVATION_3M`'s three values. */
export type Activation3MResultView = 'in_progress' | 'activated' | 'not_activated';

/** A row's status (UI V1, D-24): *Teraktivasi*, *Teraktivasi* in amber, or *Belum*. */
export type NewHireStatusView = 'activated' | 'activated_late' | 'not_yet';

/**
 * `ACTIVATION_3M_PCT` over a set (P19.11-T2 AC-2; ADR-0239): the counts and the share, `pct` `null` while nobody is due.
 * The screen shows the `pct` only (D-24); the counts are for the reader of the API.
 */
export interface Activation3MShareView {
  /** A first sale by day 90: the numerator, and part of the denominator. */
  activated: number;
  /** Past day 90 with no first sale: part of the denominator. */
  notActivated: number;
  /** A first sale after day 90: part of the denominator, not the numerator. */
  late: number;
  /** Day 90 not over and no first sale: not due yet, in neither part. */
  inProgress: number;
  /** `activated ÷ (activated + late + notActivated)`, a whole percent; `null` while nobody is due. */
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

/** `GET /new-hires` (ADR-0173; P18.8-T6 AC-2, AC-3; the year since ADR-0233, P19.9-T3 AC-1, AC-2). */
export interface NewHiresRosterView {
  today: LocalDate;
  /** Which year is listed: `current` — *Tahun berjalan*, the default — or `previous`, *Tahun lalu*. */
  year: NewHireYear;
  /** The join dates listed: that year's (`newHiresYear`) — 1 January to today, or all of last year. */
  window: { from: LocalDate; to: LocalDate };
  /** `ACTIVATION_3M.DAYS`: the day the result locks on, what *Day 64 of 90* prints. */
  days: number;
  /** The reader's scope: every new hire listed. */
  activation3M: Activation3MFiguresView;
  /** Each unit with a new hire listed — *Direct Unit* first, then the leaders A to Z. */
  units: NewHireUnitView[];
  /** By status (UI V1, D-24), each by join date, newest first, ties by name — except `inProgress`, by day. */
  sections: {
    /** `not_yet` inside their 90 days: by day, highest first; ties by name. */
    inProgress: NewHireRowView[];
    /** *Teraktivasi*: `activated` and `activated_late`, newest joiner first. */
    activated: NewHireRowView[];
    /** `not_yet` past day 90: no first sale by then nor since, newest joiner first. */
    notActivated: NewHireRowView[];
  };
}

/**
 * **A new hire's 3M standing, on their detail** (UI V1, UI-023; D-25): what the strip at the top of
 * `/new-hires/[membershipId]` says — the same status, day and source as their row on `/new-hires`, from the same
 * function. `null` for somebody who is not a new hire.
 */
export interface NewHireStandingView {
  status: NewHireStatusView;
  activation3M: Activation3MResultView;
  joinDate: LocalDate;
  /** Today's day since joining: *Hari ke-X* — the *Hari 88 /90* tile, *3M selesai* past 90. */
  day: number;
  firstSaleDate: LocalDate | null;
  /** *Pecah telor di hari ke-X*; `null` with no first sale. */
  firstSaleDay: number | null;
  firstSaleSource: FirstSaleSourceView | null;
  /**
   * **Who they report to** (UI V1, UI-027; D-25): the header's *AAB Arief · Bergabung 3 Agu 2026* — their leader's
   * membership, name and hierarchy role. `null` for somebody who reports to nobody.
   */
  leader: NewHireLeaderView | null;
  /**
   * **Their WhatsApp number** (UI V1, UI-027; UI-081, D-22): `users.phone` as stored, `+62…`, or `null` with none — the
   * detail's *WhatsApp* opens it, or *Isi nomor WhatsApp* first. Read only by a leader who coaches them: `null` for a
   * new hire who left (P19.11-T2 AC-1), whom nobody coaches now.
   */
  phone: string | null;
}

/** The hire's leader on their detail (UI-027): who, and on which rung. */
export interface NewHireLeaderView extends ActivationPersonView {
  role: 'ab' | 'aab' | 'agent';
}

/** One hire's activation as a leader reads it on `/new-hires/:membershipId` (and its writes): the view and the standing. */
export interface NewHireDetailView extends ActivationView {
  newHire: NewHireStandingView | null;
  /**
   * **Nothing on it may be written** (P19.11-T2 AC-1, UX-3; ADR-0239): a new hire who left, whom New Hires lists and the
   * detail opens for reading — nobody coaches them now, so every write route answers 404. `false` for everybody the reader
   * coaches. The page draws no write control while it is `true`.
   */
  readOnly: boolean;
}

/** Why an activation is served empty (P19.9-T3 AC-5): its first year is over, or there never was one. */
export type ActivationEmptyReason = 'first_year_over' | 'no_activation';

/**
 * **An activation served empty** (OD-289, ADR-0233; P19.9-T3 AC-5): from the join date plus `ACTIVATION.FIRST_YEAR_MONTHS`
 * the person's activation is not theirs to read any more — `GET /activation/me` answers this in its place, and so does
 * `GET /new-hires/:membershipId`, which answers it too for a new hire it lists who has no activation at all. **Nothing of
 * a checklist is in it**: the person, the dates the one line says, and — on a leader's read — who they report to, for
 * the header. Told from the full view by `empty`, which the full view does not carry.
 */
export interface ActivationEmptyView {
  empty: ActivationEmptyReason;
  hire: ActivationPersonView;
  /** The office's today. */
  today: LocalDate;
  /** Their join date, day 1; `null` for a membership that carries none. */
  joinDate: LocalDate | null;
  /** The first day it is empty — the join date plus twelve calendar months; `null` with no join date. */
  firstYearEndsOn: LocalDate | null;
  /** Who they report to, the header's *AAB Arief · Bergabung 3 Agu 2025* (UI-027); `null` on the person's own read. */
  leader: NewHireLeaderView | null;
}

/** What saving the coaching note answers. */
export interface ActivationNoteSavedView {
  note: ActivationNoteView;
}

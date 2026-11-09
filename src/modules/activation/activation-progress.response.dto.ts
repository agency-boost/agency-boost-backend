import { ApiProperty } from '@nestjs/swagger';
import {
  ACTIVATION_ITEM_SOURCES, ACTIVATION_RECORD_COLLECTIONS, type ActivationItemSource, type ActivationRecordCollection,
} from './activation-progress.schema';
import { NEW_HIRE_YEARS, type NewHireYear } from '@/domain/metrics/activation-3m';
import type {
  ActivationAspectProgressView, ActivationClosingsView, ActivationClosingView, ActivationEmptyReason, ActivationEmptyView,
  ActivationItemProgressView,
  ActivationItemRecordView, ActivationNoteSavedView, ActivationNoteView, ActivationPersonView, ActivationView,
  Activation3MFiguresView, Activation3MMonthView, Activation3MResultView, Activation3MShareView, FirstSaleSourceView,
  NewHireChecklistView, NewHireDetailView, NewHireLeaderView, NewHireRowView, NewHiresRosterView, NewHireStandingView,
  NewHireStatusView, NewHireUnitRefView, NewHireUnitView,
} from './activation-progress.view';
import type { ActivationState, AspectStatus } from './activation-rules';
import { ActivationLinkDto } from './activation.response.dto';

/** The wire shapes of a hire's activation. Each `implements` its view, so the two cannot drift. */

export class ActivationPersonDto implements ActivationPersonView {
  @ApiProperty({ type: String })
  membershipId!: string;

  @ApiProperty({ type: String, example: 'Sari Puspita', description: 'The full name.' })
  name!: string;
}

export class ActivationItemRecordDto implements ActivationItemRecordView {
  @ApiProperty({
    type: String, enum: ACTIVATION_RECORD_COLLECTIONS, example: 'leads',
    description: 'Where the record is: a lead, a coaching session, or a month of the production file (`monthlyAgentData`).',
  })
  collection!: ActivationRecordCollection;

  @ApiProperty({ type: String })
  id!: string;
}

export class ActivationItemProgressDto implements ActivationItemProgressView {
  @ApiProperty({ type: String, example: 'FIRST_CASE_CLOSED', description: 'The pinned version’s code.' })
  code!: string;

  @ApiProperty({ type: String, example: 'Close first case independently' })
  label!: string;

  @ApiProperty({
    type: ActivationLinkDto, nullable: true,
    description: 'The link, resolved; `null` for a manual item. While `live`, nobody ticks it by hand.',
  })
  link!: ActivationLinkDto | null;

  @ApiProperty({ type: Boolean })
  done!: boolean;

  @ApiProperty({ type: String, nullable: true, format: 'date-time' })
  doneAt!: string | null;

  @ApiProperty({ type: String, enum: ACTIVATION_ITEM_SOURCES, nullable: true, description: 'Who or what completed it.' })
  source!: ActivationItemSource | null;

  @ApiProperty({
    type: ActivationPersonDto, nullable: true,
    description: 'Who ticked it — or, for a link, whoever wrote the record that completed it.',
  })
  doneBy!: ActivationPersonDto | null;

  @ApiProperty({ type: String, nullable: true, description: 'The hire’s own note: only in their own read; `null` in a leader’s.' })
  note!: string | null;

  @ApiProperty({ type: String, nullable: true, example: '2026-09-29', description: 'The hire’s own date, an office date: only in their own read.' })
  date!: string | null;

  @ApiProperty({
    type: Boolean,
    description:
      '*Ticked by {name}, waiting for data*: a data-backed item ticked by hand that its data has not '
      + 'confirmed yet. From the read its data appears on, it is the link’s: `source: link` and this `false`.',
  })
  waiting!: boolean;

  @ApiProperty({
    type: ActivationItemRecordDto, nullable: true,
    description:
      'The record a done data-backed item names, for its source line (*"Completed from Sales data · {date}"*): the lead, '
      + 'the coaching session, or the production file’s month. `null` for every other item, and for one not done.',
  })
  record!: ActivationItemRecordDto | null;
}

export class ActivationClosingDto implements ActivationClosingView {
  @ApiProperty({ type: String })
  leadId!: string;

  @ApiProperty({ type: String, example: 'Ibu Ratna Kusuma', description: 'The lead’s name: who the case was sold to.' })
  name!: string;

  @ApiProperty({ type: String, example: '2026-09-02', description: 'The office day it first reached *Paid and issued*.' })
  date!: string;
}

export class ActivationClosingsDto implements ActivationClosingsView {
  @ApiProperty({
    type: [ActivationClosingDto],
    description: 'The member’s sales leads that reached *Paid and issued*, newest first: what *Which case?* names.',
  })
  closings!: ActivationClosingDto[];
}

export class ActivationAspectProgressDto implements ActivationAspectProgressView {
  @ApiProperty({ type: String, example: 'FIRST_SALE' })
  code!: string;

  @ApiProperty({ type: String, example: '4. First Sale' })
  label!: string;

  @ApiProperty({ type: String, enum: ['done', 'in_progress', 'not_started'] })
  status!: AspectStatus;

  @ApiProperty({ type: Number })
  done!: number;

  @ApiProperty({ type: Number })
  total!: number;

  @ApiProperty({ type: [ActivationItemProgressDto] })
  items!: ActivationItemProgressDto[];
}

export class ActivationNoteDto implements ActivationNoteView {
  @ApiProperty({ type: String })
  text!: string;

  @ApiProperty({ type: ActivationPersonDto })
  by!: ActivationPersonDto;

  @ApiProperty({ type: String, format: 'date-time' })
  at!: string;
}

export class ActivationStartCorrectedDto {
  @ApiProperty({ type: ActivationPersonDto })
  by!: ActivationPersonDto;

  @ApiProperty({ type: String, format: 'date-time' })
  at!: string;
}

export class ActivationViewDto implements ActivationView {
  @ApiProperty({ type: ActivationPersonDto })
  hire!: ActivationPersonDto;

  @ApiProperty({
    type: String, enum: ['open', 'graduated', 'expired'],
    description: 'Open until the hire marks it complete, or until six calendar months after its start date.',
  })
  state!: ActivationState;

  @ApiProperty({
    type: String, example: '2026-08-06',
    description: 'Day 1, an office date: the hire’s **join date** (ADR-0169 §2), the membership’s `joinDate`.',
  })
  startDate!: string;

  @ApiProperty({
    type: ActivationStartCorrectedDto, nullable: true,
    description: 'A leader’s correction of the join date: who, and when. `null` while it is the date the hire was added with.',
  })
  startCorrected!: ActivationStartCorrectedDto | null;

  @ApiProperty({ type: String, example: '2026-10-03', description: 'The office’s today: nothing is worked out in the browser.' })
  today!: string;

  @ApiProperty({ type: Number, example: 59, description: 'Whole office days since the start date, plus one; never below 1.' })
  day!: number;

  @ApiProperty({ type: Number, example: 90, description: 'The office’s activation window, in days.' })
  window!: number;

  @ApiProperty({ type: Boolean, description: 'Past the window, below 100%, and still open.' })
  overdue!: boolean;

  @ApiProperty({ type: String, example: '2027-02-06', description: 'Six calendar months after the start date, an office date.' })
  endsOn!: string;

  @ApiProperty({ type: Number })
  done!: number;

  @ApiProperty({ type: Number, description: 'The pinned version’s item count.' })
  total!: number;

  @ApiProperty({ type: Number, example: 56, description: '`round(done / total × 100)`.' })
  pct!: number;

  @ApiProperty({ type: [ActivationAspectProgressDto] })
  aspects!: ActivationAspectProgressDto[];

  @ApiProperty({ type: Boolean, description: 'The item coded `FIRST_CASE_CLOSED` is done.' })
  firstCaseClosed!: boolean;

  @ApiProperty({ type: String, nullable: true, format: 'date-time' })
  graduatedAt!: string | null;

  @ApiProperty({ type: ActivationPersonDto, nullable: true })
  graduatedBy!: ActivationPersonDto | null;

  @ApiProperty({ type: ActivationNoteDto, nullable: true, description: 'The leader’s coaching note, which the hire reads.' })
  note!: ActivationNoteDto | null;
}

const RESULTS: Activation3MResultView[] = ['in_progress', 'activated', 'not_activated'];

const STATUSES: NewHireStatusView[] = ['activated', 'activated_late', 'not_yet'];

export class Activation3MShareDto implements Activation3MShareView {
  @ApiProperty({ type: Number, description: 'Their first sale was on or before day 90 of the join date: the numerator.' })
  activated!: number;

  @ApiProperty({ type: Number, description: 'Past day 90 with no first sale: with `activated`, the denominator.' })
  notActivated!: number;

  @ApiProperty({ type: Number, description: 'A first sale after day 90 (*lewat 3M*): Teraktivasi, and in neither part of the share.' })
  late!: number;

  @ApiProperty({ type: Number, description: 'Still within their 90 days with no first sale: in neither part of the share (rule A).' })
  inProgress!: number;

  @ApiProperty({
    type: Number, nullable: true, example: 100,
    description:
      '*Aktivasi 3M*: activated by day 90 ÷ (that + past day 90 with no first sale), a whole percent; `null` while none '
      + 'of them is decided — never 0. The screen shows this alone.',
  })
  pct!: number | null;
}

export class Activation3MMonthDto extends Activation3MShareDto implements Activation3MMonthView {
  @ApiProperty({ type: String, example: '2026-07', description: 'The join month: its new hires are its cohort.' })
  month!: string;
}

export class Activation3MFiguresDto implements Activation3MFiguresView {
  @ApiProperty({ type: Activation3MShareDto, description: 'Every new hire of the set.' })
  all!: Activation3MShareDto;

  @ApiProperty({ type: [Activation3MMonthDto], description: 'Each join month with a new hire in the set, newest first.' })
  byMonth!: Activation3MMonthDto[];
}

export class NewHireUnitRefDto implements NewHireUnitRefView {
  @ApiProperty({
    type: String, enum: ['direct', 'aab', 'ab'],
    description: '*Direct Unit*, or the nearest leader below you: an AAB, or an AB under an AB — named by the rung.',
  })
  kind!: 'direct' | 'aab' | 'ab';

  @ApiProperty({ type: ActivationPersonDto, nullable: true, description: '`null` for *Direct Unit*.' })
  leader!: ActivationPersonDto | null;
}

export class NewHireUnitDto extends NewHireUnitRefDto implements NewHireUnitView {
  @ApiProperty({ type: Activation3MFiguresDto, description: 'The 3M activation % of the new hires listed in this unit.' })
  activation3M!: Activation3MFiguresDto;
}

export class NewHireChecklistDto implements NewHireChecklistView {
  @ApiProperty({ type: String, enum: ['open', 'graduated', 'expired'] })
  state!: ActivationState;

  @ApiProperty({ type: Number })
  done!: number;

  @ApiProperty({ type: Number })
  total!: number;

  @ApiProperty({ type: Number })
  pct!: number;

  @ApiProperty({ type: Boolean, description: 'Open, past the window, below 100%.' })
  overdue!: boolean;
}

export class NewHireRowDto implements NewHireRowView {
  @ApiProperty({ type: ActivationPersonDto })
  hire!: ActivationPersonDto;

  @ApiProperty({ type: NewHireUnitRefDto, description: 'The unit they are counted in.' })
  unit!: NewHireUnitRefDto;

  @ApiProperty({ type: String, example: '2026-08-06', description: 'The join date, day 1: what *Join date* prints.' })
  joinDate!: string;

  @ApiProperty({ type: Number, description: 'Which day since joining today is, the join date day 1: *Hari ke-X*.' })
  day!: number;

  @ApiProperty({
    type: String, nullable: true, example: '2026-09-01',
    description: 'The first sale (*pecah telor*): a paid and issued case, or a closing logged from the checklist; `null` with none.',
  })
  firstSaleDate!: string | null;

  @ApiProperty({
    type: Number, nullable: true, example: 30,
    description: 'The first sale’s day since joining, the join date day 1: *Pecah telor di hari ke-X*. `null` with none.',
  })
  firstSaleDay!: number | null;

  @ApiProperty({
    type: String, enum: ['sales', 'manual'], nullable: true,
    description: '`sales` — a sales lead at Paid and issued, or the production file; `manual` — a closing logged from the checklist. `null` with none.',
  })
  firstSaleSource!: FirstSaleSourceView | null;

  @ApiProperty({
    type: String, enum: STATUSES,
    description:
      'Teraktivasi as soon as there is a first sale: `activated` by day 90, `activated_late` after it (amber, outside the '
      + 'share); `not_yet` without one. Leaving is not a status.',
  })
  status!: NewHireStatusView;

  @ApiProperty({
    type: String, enum: RESULTS,
    description:
      'The 3M result: activated as soon as a first sale on or before day 90 is recorded; not activated once day 90 '
      + 'passes without one; in progress otherwise. Kept from day 91.',
  })
  activation3M!: Activation3MResultView;

  @ApiProperty({
    type: String, nullable: true,
    description: 'The day they were marked left; `null` while not. Kept as data only: it decides nothing and no screen shows it.',
  })
  leftOn!: string | null;

  @ApiProperty({
    type: NewHireChecklistDto, nullable: true,
    description: 'Their checklist; `null` for a new hire with none — an AB or an AAB, or nothing published.',
  })
  checklist!: NewHireChecklistDto | null;
}

export class NewHiresWindowDto {
  @ApiProperty({ type: String, example: '2026-01-01', description: 'The earliest join date listed: 1 January of the year.' })
  from!: string;

  @ApiProperty({ type: String, example: '2026-11-08', description: 'The latest: today for this year, 31 December for last year.' })
  to!: string;
}

export class NewHiresSectionsDto {
  @ApiProperty({ type: [NewHireRowDto], description: 'No first sale, within days 1 to 90: by day, highest first.' })
  inProgress!: NewHireRowDto[];

  @ApiProperty({ type: [NewHireRowDto], description: 'Teraktivasi — `activated` and `activated_late` — by join date, newest first.' })
  activated!: NewHireRowDto[];

  @ApiProperty({ type: [NewHireRowDto], description: 'No first sale, past day 90: by join date, newest first.' })
  notActivated!: NewHireRowDto[];
}

export class NewHiresRosterDto implements NewHiresRosterView {
  @ApiProperty({ type: String, example: '2026-10-27' })
  today!: string;

  @ApiProperty({
    type: String, enum: NEW_HIRE_YEARS, example: 'current',
    description: 'The year listed, as asked: `current` — this calendar year, the default — or `previous`, last year.',
  })
  year!: NewHireYear;

  @ApiProperty({ type: NewHiresWindowDto, description: 'The join dates listed: the year’s, in the office’s calendar.' })
  window!: NewHiresWindowDto;

  @ApiProperty({ type: Number, example: 90, description: 'The day 3M activation is decided after.' })
  days!: number;

  @ApiProperty({ type: Activation3MFiguresDto, description: 'The 3M activation % of every new hire listed.' })
  activation3M!: Activation3MFiguresDto;

  @ApiProperty({ type: [NewHireUnitDto], description: '*Direct Unit* first, then each leader below you A to Z; a unit with nobody listed omitted.' })
  units!: NewHireUnitDto[];

  @ApiProperty({ type: NewHiresSectionsDto })
  sections!: NewHiresSectionsDto;
}

/** The hire's leader on their detail (UI-027). */
export class NewHireLeaderDto extends ActivationPersonDto implements NewHireLeaderView {
  @ApiProperty({ type: String, enum: ['ab', 'aab', 'agent'], description: 'Their rung: *AB*, *AAB* or *Agent*.' })
  role!: NewHireLeaderView['role'];
}

export class NewHireStandingDto implements NewHireStandingView {
  @ApiProperty({
    type: String, enum: STATUSES,
    description: 'As on the row: `activated` by day 90, `activated_late` after it (amber), `not_yet` without a first sale.',
  })
  status!: NewHireStatusView;

  @ApiProperty({ type: String, enum: RESULTS, description: 'The 3M result, as on the row.' })
  activation3M!: Activation3MResultView;

  @ApiProperty({ type: String, example: '2026-08-03', description: 'The join date, day 1.' })
  joinDate!: string;

  @ApiProperty({ type: Number, example: 88, description: 'Today’s day since joining: *Hari 88 /90*.' })
  day!: number;

  @ApiProperty({ type: String, nullable: true, example: '2026-09-01' })
  firstSaleDate!: string | null;

  @ApiProperty({ type: Number, nullable: true, example: 30, description: '*Pecah telor di hari ke-X*; `null` with none.' })
  firstSaleDay!: number | null;

  @ApiProperty({ type: String, enum: ['sales', 'manual'], nullable: true, description: 'Where the first sale came from.' })
  firstSaleSource!: FirstSaleSourceView | null;

  @ApiProperty({
    type: NewHireLeaderDto, nullable: true,
    description: 'Who they report to (UI-027, D-25): the header’s *AAB Arief · Bergabung 3 Agu 2026*. `null` with nobody.',
  })
  leader!: NewHireLeaderDto | null;

  @ApiProperty({
    type: String, nullable: true, example: '+6281211002200',
    description:
      'Their WhatsApp number as stored (`users.phone`), or `null` with none (UI-027, UI-081): the detail’s *WhatsApp* opens '
      + 'it, or asks for it first.',
  })
  phone!: string | null;
}

/** `GET /new-hires/:membershipId`, and every write on it: the activation, and the hire's 3M standing (UI-023). */
export class NewHireDetailDto extends ActivationViewDto implements NewHireDetailView {
  @ApiProperty({
    type: NewHireStandingDto, nullable: true,
    description: 'The strip at the top of the detail (UI-023, D-25): the row’s status, from the same function. `null` for somebody who is not a new hire.',
  })
  newHire!: NewHireStandingDto | null;
}

const EMPTY_REASONS: readonly ActivationEmptyReason[] = ['first_year_over', 'no_activation'];

/**
 * An activation served empty: past the person's first year, or — on a leader's read — a new hire listed on New Hires who
 * has none. Nothing of a checklist is in it.
 */
export class ActivationEmptyDto implements ActivationEmptyView {
  @ApiProperty({
    type: String, enum: EMPTY_REASONS,
    description:
      '`first_year_over` — the join date plus twelve calendar months has come, and the activation covers the first '
      + 'year only; `no_activation` — a new hire New Hires lists who has no checklist (an AB or an AAB placed as one, or '
      + 'an office that has published none). Only this shape carries it.',
  })
  empty!: ActivationEmptyReason;

  @ApiProperty({ type: ActivationPersonDto })
  hire!: ActivationPersonDto;

  @ApiProperty({ type: String, example: '2026-11-08', description: 'The office’s today.' })
  today!: string;

  @ApiProperty({ type: String, nullable: true, example: '2025-03-03', description: 'The join date, day 1; `null` with none.' })
  joinDate!: string | null;

  @ApiProperty({
    type: String, nullable: true, example: '2026-03-03',
    description: 'The first day the activation is empty: the join date plus twelve calendar months. `null` with no join date.',
  })
  firstYearEndsOn!: string | null;

  @ApiProperty({
    type: NewHireLeaderDto, nullable: true,
    description: 'Who they report to, for the header on a leader’s read; `null` on the person’s own and with nobody.',
  })
  leader!: NewHireLeaderDto | null;
}

export class ActivationNoteSavedDto implements ActivationNoteSavedView {
  @ApiProperty({ type: ActivationNoteDto })
  note!: ActivationNoteDto;
}

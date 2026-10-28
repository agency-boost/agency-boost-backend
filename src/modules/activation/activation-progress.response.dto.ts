import { ApiProperty } from '@nestjs/swagger';
import {
  ACTIVATION_ITEM_SOURCES, ACTIVATION_RECORD_COLLECTIONS, type ActivationItemSource, type ActivationRecordCollection,
} from './activation-progress.schema';
import type {
  ActivationAspectProgressView, ActivationClosingsView, ActivationClosingView, ActivationItemProgressView,
  ActivationItemRecordView, ActivationNoteSavedView, ActivationNoteView, ActivationPersonView, ActivationView,
  Activation3MFiguresView, Activation3MMonthView, Activation3MResultView, Activation3MShareView, NewHireChecklistView,
  NewHireMarkedLeftView, NewHireRowView, NewHiresRosterView, NewHireUnitRefView, NewHireUnitView,
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

export class Activation3MShareDto implements Activation3MShareView {
  @ApiProperty({ type: Number, description: 'Their first sale was on or before day 90 of the join date.' })
  activated!: number;

  @ApiProperty({ type: Number, description: 'No first sale by day 90 — or they left before one.' })
  notActivated!: number;

  @ApiProperty({ type: Number, description: 'Still within their 90 days: in neither part of the share.' })
  inProgress!: number;

  @ApiProperty({
    type: Number, nullable: true, example: 60,
    description: 'Activated ÷ (activated + not activated), a whole percent; `null` while none of them is decided — never 0.',
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

  @ApiProperty({ type: Number, description: 'Which day of their first 90 today is, the join date day 1.' })
  day!: number;

  @ApiProperty({ type: String, nullable: true, example: '2026-08-25', description: 'The first paid and issued case; `null` with none.' })
  firstSaleDate!: string | null;

  @ApiProperty({
    type: String, enum: RESULTS,
    description: 'In progress through day 90; then activated (a first sale by day 90) or not — kept once decided.',
  })
  activation3M!: Activation3MResultView;

  @ApiProperty({ type: String, nullable: true, description: 'The day they were marked left; `null` while not.' })
  leftOn!: string | null;

  @ApiProperty({
    type: NewHireChecklistDto, nullable: true,
    description: 'Their checklist; `null` for a new hire with none — an AB or an AAB, or nothing published.',
  })
  checklist!: NewHireChecklistDto | null;
}

export class NewHiresWindowDto {
  @ApiProperty({ type: String, example: '2025-10-28', description: 'The earliest join date listed.' })
  from!: string;

  @ApiProperty({ type: String, example: '2026-10-27', description: 'Today.' })
  to!: string;
}

export class NewHiresSectionsDto {
  @ApiProperty({ type: [NewHireRowDto], description: 'Days 1 to 90, by day, highest first.' })
  inProgress!: NewHireRowDto[];

  @ApiProperty({ type: [NewHireRowDto], description: 'By join date, newest first.' })
  activated!: NewHireRowDto[];

  @ApiProperty({ type: [NewHireRowDto], description: 'By join date, newest first — the ones who left among them.' })
  notActivated!: NewHireRowDto[];
}

export class NewHiresRosterDto implements NewHiresRosterView {
  @ApiProperty({ type: String, example: '2026-10-27' })
  today!: string;

  @ApiProperty({ type: NewHiresWindowDto, description: 'The join dates listed: the last twelve months.' })
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

export class NewHireMarkedLeftDto implements NewHireMarkedLeftView {
  @ApiProperty({ type: String })
  membershipId!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  leftAt!: string;

  @ApiProperty({ type: String, example: '2026-10-27', description: 'The day it fell on.' })
  leftOn!: string;

  @ApiProperty({ type: String, enum: ['activated', 'not_activated'], description: 'Their 3M activation, decided now.' })
  activation3M!: 'activated' | 'not_activated';
}

export class ActivationNoteSavedDto implements ActivationNoteSavedView {
  @ApiProperty({ type: ActivationNoteDto })
  note!: ActivationNoteDto;
}

import { ApiProperty } from '@nestjs/swagger';
import { ACTIVATION_ITEM_SOURCES, type ActivationItemSource } from './activation-progress.schema';
import type {
  ActivationAspectProgressView, ActivationItemProgressView, ActivationNoteSavedView, ActivationNoteView,
  ActivationPersonView, ActivationView, NewHireGroupView, NewHireRowView, NewHiresRosterView,
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

  @ApiProperty({ type: String, example: '2026-08-06', description: 'Day 1, an office date.' })
  startDate!: string;

  @ApiProperty({
    type: ActivationStartCorrectedDto, nullable: true,
    description: 'A leader’s correction of the start date: who, and when. `null` while it is the join date.',
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

export class NewHireRowDto implements NewHireRowView {
  @ApiProperty({ type: ActivationPersonDto })
  hire!: ActivationPersonDto;

  @ApiProperty({ type: String, example: '2026-08-06', description: 'What *Joined* prints.' })
  startDate!: string;

  @ApiProperty({ type: Number })
  day!: number;

  @ApiProperty({ type: Number })
  window!: number;

  @ApiProperty({ type: Boolean })
  overdue!: boolean;

  @ApiProperty({ type: Number })
  pct!: number;

  @ApiProperty({ type: Boolean, description: '*Active Agent*: the item coded `FIRST_CASE_CLOSED` is done.' })
  firstCaseClosed!: boolean;
}

export class NewHireGroupDto implements NewHireGroupView {
  @ApiProperty({
    type: String, enum: ['direct', 'aab', 'ab'],
    description: '*Direct Unit*, or the nearest leader below you: an AAB, or an AB under an AB — the card names the rung.',
  })
  kind!: 'direct' | 'aab' | 'ab';

  @ApiProperty({ type: ActivationPersonDto, nullable: true, description: '`null` for *Direct Unit*.' })
  leader!: ActivationPersonDto | null;

  @ApiProperty({ type: [NewHireRowDto], description: 'By day, highest first.' })
  hires!: NewHireRowDto[];
}

export class NewHiresRosterDto implements NewHiresRosterView {
  @ApiProperty({ type: [NewHireGroupDto], description: 'Empty groups are omitted.' })
  groups!: NewHireGroupDto[];

  @ApiProperty({ type: String, example: '2026-10-03' })
  today!: string;
}

export class ActivationNoteSavedDto implements ActivationNoteSavedView {
  @ApiProperty({ type: ActivationNoteDto })
  note!: ActivationNoteDto;
}

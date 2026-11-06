import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { SURVEY_ROLE_CLASSES } from '@/domain/constants';

/**
 * **The surveys' answers, declared for OpenAPI** (P19.5-T4; `functional/surveys.md`, *Data contract*). The wire shapes
 * are the services' (`surveys.service.ts`, `survey-runs.service.ts`, `coaching-survey.service.ts`), as
 * `frontend/src/lib/surveys.ts` reads them. No shape here carries a person beside an answer, but the coaching read's.
 */

class LabelPairDto {
  @ApiProperty({ example: 'Pengetahuan produk' }) id!: string;
  @ApiProperty({ example: 'Product knowledge' }) en!: string;
}

class SurveyItemDto {
  @ApiProperty({ example: 'PRODUCT' }) kode!: string;
  @ApiProperty({ type: LabelPairDto }) label!: LabelPairDto;
  @ApiPropertyOptional({ description: 'Q4: chosen only on its own.' }) exclusive?: boolean;
}

export class MySurveyRunDto {
  @ApiProperty() runId!: string;
  @ApiProperty({ enum: ['nps', 'qual'] }) kind!: string;
  @ApiProperty({ example: '2026-Q4', description: '`YYYY-Qn`, `YYYY-Hn`, `YYYY-06` or `YYYY-12`.' }) periodKey!: string;
  @ApiProperty({ example: '2026-10-27' }) opensOn!: string;
  @ApiProperty({ example: '2026-11-09' }) closesOn!: string;
  @ApiProperty({ example: 4, description: '*n hari lagi*, in the KPM’s calendar.' }) daysLeft!: number;
  @ApiProperty({ example: 1 }) answeredCount!: number;
  @ApiProperty({ example: 6 }) totalCount!: number;
  @ApiProperty({ example: 3, description: '*±m menit*.' }) minutes!: number;
  @ApiProperty() anonymous!: boolean;
  @ApiProperty({ enum: ['anonymous', 'per_person'], nullable: true, type: String }) notice!: string | null;
}

class SentOpenDto {
  @ApiProperty() runId!: string;
  @ApiProperty({ enum: ['nps', 'qual'] }) kind!: string;
  @ApiProperty() periodKey!: string;
  @ApiProperty() closesOn!: string;
}

class PopupDto {
  @ApiProperty({ enum: ['opened', 'halfway', 'last_day'] }) moment!: string;
  @ApiProperty({ type: [String] }) runIds!: string[];
}

export class SurveyPendingDto {
  @ApiProperty({ example: '2026-11-05' }) today!: string;
  @ApiProperty({ example: '0417' }) kpmCode!: string;
  @ApiProperty({ type: [MySurveyRunDto], description: 'Open and not sent: the dot, the *Perlu diisi* cards (C-R2).' })
  open!: MySurveyRunDto[];
  @ApiProperty({ type: [SentOpenDto], description: 'Sent and still open: *"Terima kasih, survei sudah diisi"* (C-R9).' })
  sentOpen!: SentOpenDto[];
  @ApiProperty({ type: PopupDto, nullable: true, description: 'Today’s popup, or `null`; always `null` in a view-as session.' })
  popup!: PopupDto | null;
}

class SurveyHistoryDto {
  @ApiProperty() runId!: string;
  @ApiProperty({ enum: ['nps', 'qual'] }) kind!: string;
  @ApiProperty() periodKey!: string;
  @ApiProperty({ example: '2026-08-18', description: '*Diisi <tanggal>*.' }) submittedOn!: string;
}

export class SurveyListDto {
  @ApiProperty() today!: string;
  @ApiProperty({ type: [MySurveyRunDto] }) open!: MySurveyRunDto[];
  @ApiProperty({ type: [SurveyHistoryDto], description: '*Riwayat*.' }) history!: SurveyHistoryDto[];
}

class FormRunDto {
  @ApiProperty() runId!: string;
  @ApiProperty({ enum: ['nps', 'qual'] }) kind!: string;
  @ApiProperty() periodKey!: string;
  @ApiProperty() opensOn!: string;
  @ApiProperty() closesOn!: string;
  @ApiProperty({ enum: ['anonymous', 'per_person'], nullable: true, type: String }) notice!: string | null;
  @ApiProperty() anonymous!: boolean;
  @ApiProperty({ example: '0417' }) kpmCode!: string;
}

class ScaleDto {
  @ApiProperty({ example: 0 }) min!: number;
  @ApiProperty({ example: 10 }) max!: number;
}

class FormQuestionDto {
  @ApiProperty({ example: 'P1' }) kode!: string;
  @ApiProperty({
    enum: ['score', 'text', 'aspiration', 'scale_items', 'state_items', 'unit_items', 'downline_yes_no', 'downline_areas', 'support'],
  })
  type!: string;
  @ApiProperty({ type: LabelPairDto, description: '`{perusahaan}` and `{kpm}` filled.' }) text!: LabelPairDto;
  @ApiProperty({ type: [SurveyItemDto] }) items!: SurveyItemDto[];
  @ApiProperty({ description: '*Kenapa? (opsional)*.' }) askWhy!: boolean;
  @ApiProperty() required!: boolean;
  @ApiProperty({ type: String, nullable: true }) blockKode!: string | null;
  @ApiProperty({ type: LabelPairDto, nullable: true }) blockTitle!: LabelPairDto | null;
  @ApiProperty({ type: ScaleDto, nullable: true, description: '0–10 for a score and *Dukungan leader*; 1–5 for an item.' })
  scale!: ScaleDto | null;
}

class DownlineLeaderDto {
  @ApiProperty() membershipId!: string;
  @ApiProperty({ example: 'Sari Puspita' }) name!: string;
}

export class SurveyFormDto {
  @ApiProperty({ type: FormRunDto }) run!: FormRunDto;
  @ApiProperty({ enum: ['open', 'submitted', 'closed'] }) state!: string;
  @ApiProperty({ type: [FormQuestionDto], description: 'Empty unless `open`.' }) questions!: FormQuestionDto[];
  @ApiProperty({ type: Object, description: 'The member’s saved answers by question kode; `{}` in a view-as session.' })
  answers!: Record<string, unknown>;
  @ApiProperty() answeredCount!: number;
  @ApiProperty() totalCount!: number;
  @ApiProperty({ description: 'Where *Lanjutkan* opens.' }) resumeIndex!: number;
  @ApiProperty({ type: [DownlineLeaderDto], description: 'Q11’s rows: the member’s own downline leaders.' })
  downlineLeaders!: DownlineLeaderDto[];
}

export class SurveyAnswerSavedDto {
  @ApiProperty({ example: 1 }) answeredCount!: number;
  @ApiProperty({ example: 6 }) totalCount!: number;
}

export class SurveySubmittedDto {
  @ApiProperty({ example: '2026-11-05T03:12:00.000Z' }) submittedAt!: string;
}

// ------------------------------------------------------------------------------------------- the KPM's tabs

class ResponseRateDto {
  @ApiProperty({ example: 12 }) sent!: number;
  @ApiProperty({ example: 30 }) invited!: number;
  @ApiProperty({ type: Number, nullable: true, example: 40, description: '`SURVEY_RESPONSE_RATE`.' }) pct!: number | null;
}

export class SurveyRunDto {
  @ApiProperty() runId!: string;
  @ApiProperty({ enum: ['nps', 'qual'] }) kind!: string;
  @ApiProperty({ example: '2026-Q4' }) periodKey!: string;
  @ApiProperty() opensOn!: string;
  @ApiProperty() closesOn!: string;
  @ApiProperty({ enum: ['scheduled', 'open', 'closed'], description: '*Terjadwal · Berjalan · Selesai*.' }) state!: string;
  @ApiProperty({ enum: SURVEY_ROLE_CLASSES, isArray: true }) invitedRoleClasses!: string[];
  @ApiProperty() anonymous!: boolean;
  @ApiProperty() perPerson!: boolean;
  @ApiProperty() remindHalfway!: boolean;
  @ApiProperty({ type: ResponseRateDto }) responses!: ResponseRateDto;
}

class TemplateDefaultsDto {
  @ApiProperty() anonymous!: boolean;
  @ApiProperty() perPerson!: boolean;
  @ApiProperty() remindHalfway!: boolean;
}

class SurveyTemplateDto {
  @ApiProperty({ enum: ['quarter', 'half'] }) cadence!: string;
  @ApiProperty({ type: [Number], example: [6, 12] }) qualMonths!: number[];
  @ApiProperty({ type: TemplateDefaultsDto }) defaults!: TemplateDefaultsDto;
}

class SelectedRunDto extends SurveyRunDto {
  @ApiProperty({ type: String, nullable: true }) previousRunId!: string | null;
  @ApiProperty({
    type: Object, nullable: true,
    description: '`NPS_SCORE`: `cutoffs`, `respondents`, `overall`, `change`, `aspects`, `questions` (with `textChanged`), '
      + '`openAnswers` (`null` in a summary) and `breakdowns` by role class, tenure band and age band — a cell under three '
      + 'respondents `null`, and never the only one of its dimension. **An anonymous run under three respondents**: '
      + '`overall`, every score and change, and `openAnswers` are `null`; the counts stay. Never a person.',
  })
  nps!: Record<string, unknown> | null;
  @ApiProperty({
    type: Object, nullable: true,
    description: '`QUAL_ITEM_ISSUE_PCT` per block and item, with `severity`; `aspiration`; `support` (`QUAL_LEADER_SUPPORT`, the '
      + 'Owner’s and the Admins’ alone, else `null`); `coachingDownline`. **An anonymous run’s figure over fewer than three '
      + 'answers** (an item’s `issues`, `issuePct`, `severity`; an aspiration’s `count`, `pct`; a support share; '
      + '`coachingDownline.pct`, `good`) is `null`; how many answered stays. Never a person, a note or a reason.',
  })
  qual!: Record<string, unknown> | null;
}

export class SurveyResultsDto {
  @ApiProperty({ enum: ['nps', 'qual'] }) kind!: string;
  @ApiProperty() today!: string;
  @ApiProperty({ description: 'The tab is shown: the section on, or a run still open (AT-12).' }) visible!: boolean;
  @ApiProperty() sectionOn!: boolean;
  @ApiProperty({ description: '*Mulai survei*, *Ubah*, *Batalkan* may be offered.' }) canWrite!: boolean;
  @ApiProperty({ enum: ['office', 'core_leader', 'summary'] }) audience!: string;
  @ApiProperty({ type: SurveyTemplateDto }) template!: SurveyTemplateDto;
  @ApiProperty({ type: [SurveyRunDto] }) runs!: SurveyRunDto[];
  @ApiProperty({ type: SelectedRunDto, nullable: true }) selected!: SelectedRunDto | null;
}

// -------------------------------------------------------------------------------------- the coaching tab

class CoachingSurveyRunDto {
  @ApiProperty() runId!: string;
  @ApiProperty({ example: '2026-06' }) periodKey!: string;
  @ApiProperty() opensOn!: string;
  @ApiProperty({ example: '2026-06-30', description: '*Survei ditutup <tanggal>.*' }) closesOn!: string;
  @ApiProperty({ type: String, nullable: true }) submittedOn!: string | null;
}

class CoachingPersonDto {
  @ApiProperty({ enum: SURVEY_ROLE_CLASSES }) roleClass!: string;
  @ApiProperty({ type: String, nullable: true, enum: ['full_time', 'part_time'] }) workStatus!: string | null;
  @ApiProperty({ type: Number, nullable: true, description: '*Masa kerja*, whole years in this KPM.' }) tenureYears!: number | null;
  @ApiProperty({ type: Number, nullable: true }) age!: number | null;
  @ApiProperty({ type: Number, nullable: true, description: '0 *Gen Z*, 1 *Gen Y*, 2 *Gen X*.' }) generation!: number | null;
}

class IssueCountDto {
  @ApiProperty({ example: 'SALES' }) kode!: string;
  @ApiProperty({ type: LabelPairDto }) title!: LabelPairDto;
  @ApiProperty({ example: 4 }) count!: number;
}

export class CoachingSurveyDto {
  @ApiProperty({ enum: ['answered', 'not_answered', 'anonymous', 'none'] }) state!: string;
  @ApiProperty({ type: CoachingSurveyRunDto, nullable: true }) run!: CoachingSurveyRunDto | null;
  @ApiProperty({ type: CoachingPersonDto, nullable: true }) person!: CoachingPersonDto | null;
  @ApiProperty({ type: Number, nullable: true, example: 3 }) issueMaxRating!: number | null;
  @ApiProperty({ type: [IssueCountDto], description: '*Item bermasalah*.' }) issueCounts!: IssueCountDto[];
  @ApiProperty({ type: Object, nullable: true, description: 'Q4: `{ kode, options: [{ kode, label, chosen }], note }`.' })
  aspiration!: Record<string, unknown> | null;
  @ApiProperty({
    type: [Object],
    description: 'One card per section: `scale`, `state`, `unit` or `downline`, each with its items. Never Q12.',
  })
  sections!: Record<string, unknown>[];
}

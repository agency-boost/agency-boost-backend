import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsBoolean, IsIn, IsMongoId, IsObject, IsOptional, ValidateBy,
  ValidateIf,
} from 'class-validator';
import { isLocalDate } from '@/common/time/local-day';
import { field } from '@/common/validation/violations';
import { SURVEY_ROLE_CLASSES, type SurveyRoleClass } from '@/domain/constants';
import type { ReminderMoment } from './survey-participation.schema';
import type { SurveyKind } from './survey-run.schema';
import { SURVEY_REFUSALS } from './surveys.messages';

const SAY = SURVEY_REFUSALS.VALIDATION_FAILED;

/** Absent is "leave it"; `null` is refused (the `unit-dashboard.dto.ts` convention). */
const Sent = () => ValidateIf((_: unknown, value: unknown) => value !== undefined);

/** A real KPM calendar day, `YYYY-MM-DD`. */
function IsOfficeDate() {
  return ValidateBy({
    name: 'isOfficeDate',
    validator: { validate: (value: unknown) => isLocalDate(value), defaultMessage: () => field(SAY.dateShape) },
  });
}

/** *Mulai survei*'s dialog (ADR-0216 §2; AC-1). */
export class CreateSurveyRunDto {
  @ApiProperty({ enum: ['nps', 'qual'], description: 'NPS, or the qualitative survey.' })
  @IsIn(['nps', 'qual'])
  kind!: SurveyKind;

  @ApiProperty({ example: '2026-10-27', description: 'The first day, in the KPM’s calendar; today or later.' })
  @IsOfficeDate()
  opensOn!: string;

  @ApiProperty({ example: '2026-11-09', description: 'The last day, in the KPM’s calendar; in the same period as `opensOn`.' })
  @IsOfficeDate()
  closesOn!: string;

  @ApiProperty({ enum: SURVEY_ROLE_CLASSES, isArray: true, example: ['agent', 'aab', 'ab'], description: 'The role classes invited.' })
  @IsArray()
  @ArrayMinSize(1, { message: field(SAY.noRoles) })
  @ArrayMaxSize(SURVEY_ROLE_CLASSES.length)
  @ArrayUnique()
  @IsIn(SURVEY_ROLE_CLASSES, { each: true })
  invitedRoleClasses!: SurveyRoleClass[];

  @ApiProperty({ description: '*Anonim*: the answers are stored with no person on them.' })
  @IsBoolean()
  anonymous!: boolean;

  @ApiPropertyOptional({ description: 'A qualitative run’s *Tampilkan jawaban per orang*; forced off while `anonymous`, and for NPS.' })
  @IsOptional()
  @IsBoolean()
  perPerson?: boolean;

  @ApiProperty({ description: '*Ingatkan di tengah*. *Ingatkan 1 hari sebelum berakhir* is always on and is not sent.' })
  @IsBoolean()
  remindHalfway!: boolean;
}

/** A scheduled run's settings changed (`PATCH`): each field absent is left as it is. */
export class UpdateSurveyRunDto {
  @ApiPropertyOptional({ example: '2026-10-27' })
  @Sent()
  @IsOfficeDate()
  opensOn?: string;

  @ApiPropertyOptional({ example: '2026-11-09' })
  @Sent()
  @IsOfficeDate()
  closesOn?: string;

  @ApiPropertyOptional({ enum: SURVEY_ROLE_CLASSES, isArray: true })
  @Sent()
  @IsArray()
  @ArrayMinSize(1, { message: field(SAY.noRoles) })
  @ArrayMaxSize(SURVEY_ROLE_CLASSES.length)
  @ArrayUnique()
  @IsIn(SURVEY_ROLE_CLASSES, { each: true })
  invitedRoleClasses?: SurveyRoleClass[];

  @ApiPropertyOptional()
  @Sent()
  @IsBoolean()
  anonymous?: boolean;

  @ApiPropertyOptional()
  @Sent()
  @IsBoolean()
  perPerson?: boolean;

  @ApiPropertyOptional()
  @Sent()
  @IsBoolean()
  remindHalfway?: boolean;
}

/** The results' run: absent, the newest that has opened. */
export class SurveyResultsQueryDto {
  @ApiPropertyOptional({ description: 'A run of this KPM’s, by id.' })
  @IsOptional()
  @IsMongoId()
  runId?: string;
}

/** One answer, autosaved (C-R6). Its shape is the question type’s (`functional/surveys.md`, *Data contract*). */
export class SurveyAnswerDto {
  @ApiProperty({
    type: Object,
    example: { score: 8, why: 'Leadernya mendukung.' },
    description: 'By the question’s type: `{ score, why? }`, `{ text }`, `{ chosen, note? }`, `{ [itemKode]: 1..5 }`, '
      + '`{ [itemKode]: state }`, `{ answer }`, `{ leaders: [{ membershipId, areas }] }` or `{ score, reason? }`.',
  })
  @IsObject()
  value!: Record<string, unknown>;
}

/** The popup was drawn (C-R3, C-R4). */
export class PopupShownDto {
  @ApiProperty({ enum: ['opened', 'halfway', 'last_day'] })
  @IsIn(['opened', 'halfway', 'last_day'])
  moment!: ReminderMoment;

  @ApiProperty({ type: [String], description: 'The runs the popup named.' })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @IsMongoId({ each: true })
  runIds!: string[];
}

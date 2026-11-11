import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsString, Matches, ValidateIf } from 'class-validator';
import { GENDERS, WORK_STATUSES, type Gender, type WorkStatus } from '@/domain/constants';
import { field } from '@/common/validation/violations';
import { AUTH_REFUSALS } from '@/modules/auth/auth.messages';
import { PHONE_FIELD_SHAPE, phoneFromBody } from '@/modules/users/phone-input';
import { MemberPersonalDto } from './org.response.dto';
import type { MemberPersonalCompleted, PersonalField } from './member-personal.service';

/** The profile's own sentences for the same five fields (`UpdateProfileDto`), so the two forms refuse alike. */
const SAY = AUTH_REFUSALS.VALIDATION_FAILED;
const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_SHAPE = /^\d{4}-\d{2}$/;

/**
 * **What *Lengkapi data* sends** (P19.12-T5 AC-3; ADR-0248 §3): the blank fields the office fills, each optional, at least
 * one of them. **None is clearable** — a `null` is refused like any other wrong value — because this form only adds.
 */
export class CompleteMemberPersonalDto {
  @ApiPropertyOptional({ example: '1990-03-15', description: '`YYYY-MM-DD`. In the past, and at least 18 years ago in the office’s calendar.' })
  @ValidateIf((_, value) => value !== undefined)
  @IsString()
  @Matches(DATE_SHAPE, { message: field(SAY.dateOfBirthShape) })
  dateOfBirth?: string;

  @ApiPropertyOptional({ enum: GENDERS })
  @ValidateIf((_, value) => value !== undefined)
  @IsIn(GENDERS, { message: field(SAY.genderShape) })
  gender?: Gender;

  @ApiPropertyOptional({ example: '2021-07', description: '`YYYY-MM`: the month they joined the insurer. Not in the future.' })
  @ValidateIf((_, value) => value !== undefined)
  @IsString()
  @Matches(MONTH_SHAPE, { message: field(SAY.companyJoinMonthShape) })
  companyJoinMonth?: string;

  @ApiPropertyOptional({ enum: WORK_STATUSES, description: 'How they work in this office; written on the membership.' })
  @ValidateIf((_, value) => value !== undefined)
  @IsIn(WORK_STATUSES, { message: field(SAY.workStatusShape) })
  workStatus?: WorkStatus;

  @ApiPropertyOptional({
    type: String,
    example: '0812-1100-2200',
    description: 'Their WhatsApp number. Spaces, dashes, dots and brackets go, and a leading `+62`, `62` or `0`; what is '
      + 'left must be 9 to 13 digits, stored as `+62…`, else `400 VALIDATION_FAILED` naming `phone`. Not clearable.',
  })
  @Transform(({ value }) => phoneFromBody(value))
  @ValidateIf((_, value) => value !== undefined)
  // No `@IsString()`: the shape refuses anything that is not text, `null` included, in one sentence.
  @Matches(PHONE_FIELD_SHAPE, { message: field(SAY.phoneShape) })
  phone?: string;
}

/** What `PATCH /members/:membershipId/personal` answers. */
export class MemberPersonalCompletedDto implements MemberPersonalCompleted {
  @ApiProperty({ type: String })
  membershipId!: string;

  @ApiProperty({
    type: String, isArray: true, enum: ['dateOfBirth', 'gender', 'companyJoinMonth', 'workStatus', 'phone'],
    description: 'The fields this request filled, by their API names.',
  })
  filled!: PersonalField[];

  @ApiProperty({ type: () => MemberPersonalDto, description: 'What the member page’s *Data pribadi* now shows.' })
  personal!: MemberPersonalDto;
}

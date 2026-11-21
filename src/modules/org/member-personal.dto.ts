import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsIn, IsString, Matches, MaxLength, ValidateIf } from 'class-validator';
import { AGENT_CODE_PATTERN, GENDERS, WORK_STATUSES, type Gender, type WorkStatus } from '@/domain/constants';
import { field } from '@/common/validation/violations';
import { AUTH_REFUSALS } from '@/modules/auth/auth.messages';
import { JOINING_REFUSALS } from '@/domain/constants/joining.messages';
import { PHONE_FIELD_SHAPE, phoneFromBody } from '@/modules/users/phone-input';
import { DirectoryMemberDto, MemberPersonalDto } from './org.response.dto';
import type { DirectoryMember } from './directory.service';
import type { MemberPersonalCompleted, PersonalField } from './member-personal.service';

/** The profile's own sentences for the same five fields (`UpdateProfileDto`), so the two forms refuse alike. */
const SAY = AUTH_REFUSALS.VALIDATION_FAILED;
const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_SHAPE = /^\d{4}-\d{2}$/;

/**
 * **What the member sheet sends** (P19.20-T2 AC-2; ADR-0273 §3, amending ADR-0248 §3): the fields the office changes, each
 * optional, at least one of them — any value, not only a blank. **None is clearable**: a `null` is refused like any
 * other wrong value, because a field the sheet shows empty is filled, never emptied.
 */
export class CompleteMemberPersonalDto {
  @ApiPropertyOptional({ example: '2025-09-20', description: '*Bergabung di KPM*, `YYYY-MM-DD`: not after the office’s today, not before the earliest join date. Written on the membership.' })
  @ValidateIf((_, value) => value !== undefined)
  @IsString()
  @Matches(DATE_SHAPE, { message: field(JOINING_REFUSALS.VALIDATION_FAILED.notADate) })
  joinDate?: string;

  @ApiPropertyOptional({
    example: '80009', pattern: AGENT_CODE_PATTERN.source,
    description: '*Kode agen*: digits, 3 to 32. Free at the insurer, else `409 AGENT_CODE_TAKEN`. Written on the account and on this office’s membership.',
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @ValidateIf((_, value) => value !== undefined)
  @IsString()
  @Matches(AGENT_CODE_PATTERN, { message: field(SAY.agentCodeShape) })
  agentCode?: string;

  @ApiPropertyOptional({
    example: 'budi@kpm0417.test',
    description: '*Email*, lower-cased. Only for somebody who has never signed in (`409 MEMBER_EMAIL_SIGNED_IN`); free, else `409 AUTH_EMAIL_TAKEN`.',
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @ValidateIf((_, value) => value !== undefined)
  @IsEmail()
  @MaxLength(254)
  email?: string;

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
    type: String, isArray: true,
    enum: ['joinDate', 'companyJoinMonth', 'workStatus', 'agentCode', 'dateOfBirth', 'gender', 'phone', 'email'],
    description: 'The fields this request changed, by their API names; a value sent as stored is not among them.',
  })
  filled!: PersonalField[];

  @ApiProperty({ type: () => MemberPersonalDto, description: 'The person’s details as the sheet now shows them.' })
  personal!: MemberPersonalDto;

  @ApiProperty({ type: () => DirectoryMemberDto, description: 'The member as `GET /members/:membershipId` now reads them.' })
  member!: DirectoryMember;
}

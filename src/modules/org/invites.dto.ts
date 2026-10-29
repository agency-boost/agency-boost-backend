import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsMongoId, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { field } from '@/common/validation/violations';
import { AGENT_CODE_PATTERN, INVITES } from '@/domain/constants';
import { ONBOARDING_REFUSALS } from './onboarding.messages';

/** The form's own sentences, in both languages (`field`, P18.98-T5 AC-3). */
const SAY = ONBOARDING_REFUSALS.VALIDATION_FAILED;

const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;
/** What a person types for a WhatsApp number: digits, spaces and dashes, a `+` in front at most. */
const PHONE_SHAPE = /^\+?\d[\d -]{7,22}$/;
const trimmed = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/**
 * **+ Add agent** (ADR-0170 §1, P18.96-T3 AC-1): the one form's four fields, and — the Owner's and an Admin's — whose
 * unit. Shapes only; what the code decides, and whether the date may be used, is the service's.
 */
export class AddAgentDto {
  @ApiProperty({ example: '80777', minLength: 3, maxLength: 32, pattern: AGENT_CODE_PATTERN.source, description: 'Issued by the company: digits only.' })
  @Transform(trimmed)
  @IsString()
  @Matches(AGENT_CODE_PATTERN, { message: field(SAY.agentCodeShape) })
  agentCode!: string;

  @ApiProperty({ example: 'Hendra Wijaya', maxLength: INVITES.NAME_MAX })
  @Transform(trimmed)
  @IsString()
  @MinLength(1, { message: field(SAY.fullNameEmpty) })
  @MaxLength(INVITES.NAME_MAX)
  fullName!: string;

  @ApiProperty({ example: '0812-3456-7890', description: 'Their WhatsApp number, as typed. The share link reads it.' })
  @Transform(trimmed)
  @IsString()
  @Matches(PHONE_SHAPE, { message: field(SAY.phoneShape) })
  phone!: string;

  @ApiPropertyOptional({
    example: '2026-10-27',
    description: 'The day they joined, an office date. The office’s today when omitted; never after it, never before 1980.',
  })
  @IsOptional()
  @IsString()
  @Matches(DATE_SHAPE, { message: field(SAY.joinDateShape) })
  joinDate?: string;

  @ApiPropertyOptional({
    description:
      'The Owner’s or an Admin’s choice of unit: any active member of the office. A leader adds to their own unit, '
      + 'and naming anybody else is 404.',
  })
  @IsOptional()
  @IsMongoId()
  leaderMembershipId?: string;
}

/** Declining a transfer request: the reason, sent to whoever asked. */
export class DeclineTransferDto {
  @ApiPropertyOptional({ example: 'Keep him with Sari until his first case closes.', maxLength: 300 })
  @IsOptional()
  @Transform(trimmed)
  @IsString()
  @MaxLength(300)
  reason?: string;
}

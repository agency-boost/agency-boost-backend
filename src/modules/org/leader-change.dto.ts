import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsMongoId, IsOptional, IsString, MaxLength } from 'class-validator';
import { field } from '@/common/validation/violations';
import { ORG_REFUSALS } from './org.messages';
import { TRANSFER_NOTE_MAX } from './transfer-request.schema';

/** The DTOs' own sentences, in both languages (`field`, P18.10-T5 AC-3). */
const SAY = ORG_REFUSALS.VALIDATION_FAILED;
const trimmed = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/** The picker's search (`GET /members/:id/leader-choices`). */
export class LeaderChoicesQueryDto {
  @ApiPropertyOptional({ description: 'Part of a name or an agent code, case-insensitive. Empty or absent lists the first leaders.' })
  @IsOptional()
  @Transform(trimmed)
  @IsString()
  @MaxLength(120)
  q?: string;
}

/**
 * **Who they should report to, and why** (P19.12-T4; ADR-0247): `PUT /members/:id/leader` and
 * `POST /members/:id/transfer-request`. Shapes only; who may, and where to, is the service's.
 */
export class ChangeLeaderDto {
  @ApiProperty({ description: 'The new leader: an active member of the office who can hold a unit.' })
  @IsMongoId({ message: field(SAY.leaderMembershipIdShape) })
  leaderMembershipId!: string;

  @ApiPropertyOptional({
    example: 'Lives near Sari’s office',
    maxLength: TRANSFER_NOTE_MAX,
    description: 'Why, as typed: kept on the move’s history row and audit row, or shown to whoever decides a request.',
  })
  @IsOptional()
  @Transform(trimmed)
  @IsString()
  @MaxLength(TRANSFER_NOTE_MAX, { message: field(SAY.moveReasonShape) })
  reason?: string;
}

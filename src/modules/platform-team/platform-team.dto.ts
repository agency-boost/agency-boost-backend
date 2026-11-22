import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsString, MaxLength } from 'class-validator';
import { field } from '@/common/validation/violations';
import { PLATFORM_TEAM_REFUSALS } from './platform-team.messages';

/**
 * **`POST /admin/platform/team`** (P19.23-T6 AC-2): the email of the account to make a Super Admin. Trimmed and
 * lower-cased **before** it is validated, so a pasted address with a space around it is the address, not a refusal.
 */
export class AddSuperAdminDto {
  @ApiProperty({ example: 'dina@agencyboost.id', description: 'The account’s email, as it signs in.' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsString({ message: field(PLATFORM_TEAM_REFUSALS.VALIDATION_FAILED.email) })
  @MaxLength(254, { message: field(PLATFORM_TEAM_REFUSALS.VALIDATION_FAILED.email) })
  @IsEmail({}, { message: field(PLATFORM_TEAM_REFUSALS.VALIDATION_FAILED.email) })
  email!: string;
}

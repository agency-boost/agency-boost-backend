import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

/** The longest reason *Hapus akun* keeps. */
export const RETIREMENT_REASON_MAX = 500;

/** ***Hapus akun*'s body** (P19.31-T2 AC-2; ADR-0289 §3): why, and the person's full name typed to confirm. */
export class RetireAccountDto {
  @ApiProperty({ example: 'Dibuat ulang dari file District 41 (PruDynamic).', minLength: 1, maxLength: RETIREMENT_REASON_MAX })
  @IsString()
  @MinLength(1)
  @MaxLength(RETIREMENT_REASON_MAX)
  reason!: string;

  @ApiProperty({
    example: 'Simonta Tuan',
    description: 'The account\'s full name, typed in full: compared with spaces collapsed and in any case. Another name is '
      + '`400 VALIDATION_FAILED`, `details.field: fullName`.',
  })
  @IsString()
  @MaxLength(200)
  fullName!: string;
}

export class RetirementMembershipDto {
  @ApiProperty() membershipId!: string;
  @ApiProperty() kpmId!: string;
  @ApiProperty({ example: 'Bekasi Barat Branch' }) kpmName!: string;
  @ApiProperty({ example: '0602' }) kpmCode!: string;
  @ApiProperty({ enum: ['active', 'pending'] }) status!: string;
}

export class RetirementRefusalDto {
  @ApiProperty({ enum: ['ACCOUNT_RETIRE_PLATFORM_TEAM', 'ACCOUNT_RETIRE_OWNER', 'ACCOUNT_RETIRE_HAS_REPORTS'] }) code!: string;
  @ApiProperty({ description: 'The refusal\'s sentence in the reader\'s language: what to do first.' }) message!: string;
  @ApiProperty({ type: Object }) details!: Record<string, unknown>;
}

/** **What *Hapus akun* would do** — shown before it is done, a refusal in place of the button. */
export class RetirementPreviewDto {
  @ApiProperty() userId!: string;
  @ApiProperty({ example: 'Simonta Tuan' }) fullName!: string;
  @ApiProperty({ example: 'simonta@example.com' }) email!: string;
  @ApiProperty({ type: RetirementMembershipDto, nullable: true, description: 'The one live membership, which retiring ends.' })
  membership!: RetirementMembershipDto | null;
  @ApiProperty({ example: 1, description: 'In how many KPMs they have been a member, ended or not: the history that stays.' })
  kpmsWithHistory!: number;
  @ApiProperty({ type: RetirementRefusalDto, nullable: true }) refusal!: RetirementRefusalDto | null;
}

export class RetirementEndedDto {
  @ApiProperty() membershipId!: string;
  @ApiProperty() kpmId!: string;
}

/** **What it did.** */
export class RetirementResultDto {
  @ApiProperty() userId!: string;
  @ApiProperty({ example: 'Simonta Tuan' }) fullName!: string;
  @ApiProperty({ example: '2026-11-23T03:00:00.000Z' }) retiredAt!: string;
  @ApiProperty({ type: RetirementEndedDto, nullable: true }) membershipEnded!: RetirementEndedDto | null;
  @ApiProperty({ example: 0 }) invitationsCancelled!: number;
}
